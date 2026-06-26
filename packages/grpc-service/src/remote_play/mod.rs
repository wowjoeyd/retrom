use diesel::{ExpressionMethods, OptionalExtension, QueryDsl, SelectableHelper};
use diesel_async::RunQueryDsl;
use retrom_codegen::retrom::{
    remote_play_service_server::RemotePlayService, CancelSessionRequest, CancelSessionResponse,
    CreateSessionRequest, CreateSessionResponse, GetPendingSessionForHostRequest,
    GetPendingSessionForHostResponse, GetSessionRequest, GetSessionResponse, RemotePlaySession,
    RemotePlaySessionState, UpdateSessionStateRequest, UpdateSessionStateResponse,
};
use retrom_codegen::timestamp::Timestamp;
use retrom_db::{schema, Pool};
use retrom_service_common::remote_play::{is_terminal, transition};
use std::sync::Arc;
use std::time::SystemTime;
use tonic::{Request, Response, Status};

/// Session broker handlers for Remote Play.
///
/// The server only brokers sessions: it persists the coordination record and
/// validates state transitions. It never relays game video/audio/input -- that
/// stream goes Sunshine (host) -> Moonlight (client) directly.
pub struct RemotePlayServiceHandlers {
    db_pool: Arc<Pool>,
}

impl RemotePlayServiceHandlers {
    pub fn new(db_pool: Arc<Pool>) -> Self {
        Self { db_pool }
    }
}

fn internal<E: std::fmt::Display>(why: E) -> Status {
    Status::internal(why.to_string())
}

fn now_ts() -> Timestamp {
    SystemTime::now().into()
}

#[tonic::async_trait]
impl RemotePlayService for RemotePlayServiceHandlers {
    async fn create_session(
        &self,
        request: Request<CreateSessionRequest>,
    ) -> Result<Response<CreateSessionResponse>, Status> {
        let request = request.into_inner();

        let mut new_session = request
            .session
            .ok_or_else(|| Status::invalid_argument("session is required"))?;

        // A brokered session always starts in REQUESTED, regardless of input.
        new_session.state = RemotePlaySessionState::Requested as i32;

        let mut conn = self.db_pool.get().await.map_err(internal)?;

        let session: RemotePlaySession = diesel::insert_into(schema::remote_play_sessions::table)
            .values(new_session)
            .get_result(&mut conn)
            .await
            .map_err(internal)?;

        Ok(Response::new(CreateSessionResponse {
            session: Some(session),
        }))
    }

    async fn get_pending_session_for_host(
        &self,
        request: Request<GetPendingSessionForHostRequest>,
    ) -> Result<Response<GetPendingSessionForHostResponse>, Status> {
        let host_client_id = request.into_inner().host_client_id;

        let mut conn = self.db_pool.get().await.map_err(internal)?;

        // The oldest still-REQUESTED session targeted at this host, if any.
        let session: Option<RemotePlaySession> = schema::remote_play_sessions::table
            .filter(schema::remote_play_sessions::host_client_id.eq(host_client_id))
            .filter(
                schema::remote_play_sessions::state.eq(RemotePlaySessionState::Requested as i32),
            )
            .order(schema::remote_play_sessions::created_at.asc())
            .select(RemotePlaySession::as_select())
            .first(&mut conn)
            .await
            .optional()
            .map_err(internal)?;

        Ok(Response::new(GetPendingSessionForHostResponse { session }))
    }

    async fn get_session(
        &self,
        request: Request<GetSessionRequest>,
    ) -> Result<Response<GetSessionResponse>, Status> {
        let id = request.into_inner().id;

        let mut conn = self.db_pool.get().await.map_err(internal)?;

        let session: Option<RemotePlaySession> = schema::remote_play_sessions::table
            .find(id)
            .select(RemotePlaySession::as_select())
            .first(&mut conn)
            .await
            .optional()
            .map_err(internal)?;

        Ok(Response::new(GetSessionResponse { session }))
    }

    async fn update_session_state(
        &self,
        request: Request<UpdateSessionStateRequest>,
    ) -> Result<Response<UpdateSessionStateResponse>, Status> {
        let request = request.into_inner();
        let id = request.id;

        let to = RemotePlaySessionState::try_from(request.state)
            .map_err(|_| Status::invalid_argument("unknown target state"))?;

        let mut conn = self.db_pool.get().await.map_err(internal)?;

        let current: RemotePlaySession = schema::remote_play_sessions::table
            .find(id)
            .select(RemotePlaySession::as_select())
            .first(&mut conn)
            .await
            .optional()
            .map_err(internal)?
            .ok_or_else(|| Status::not_found(format!("remote play session {id} not found")))?;

        let from = RemotePlaySessionState::try_from(current.state)
            .map_err(|_| Status::internal("stored session has an unknown state"))?;

        transition(from, to).map_err(|why| Status::failed_precondition(why.to_string()))?;

        let now = now_ts();
        let started_at = if to == RemotePlaySessionState::Running {
            Some(now)
        } else {
            current.started_at
        };
        let ended_at = if is_terminal(to) {
            Some(now)
        } else {
            current.ended_at
        };
        // Only carry failure detail when failing; otherwise keep what's stored.
        let (error_code, error_message) = if to == RemotePlaySessionState::Failed {
            (request.error_code, request.error_message)
        } else {
            (current.error_code, current.error_message)
        };

        use schema::remote_play_sessions::dsl;
        let updated: RemotePlaySession = diesel::update(schema::remote_play_sessions::table.find(id))
            .set((
                dsl::state.eq(to as i32),
                dsl::updated_at.eq(Some(now)),
                dsl::started_at.eq(started_at),
                dsl::ended_at.eq(ended_at),
                dsl::error_code.eq(error_code),
                dsl::error_message.eq(error_message),
            ))
            .get_result(&mut conn)
            .await
            .map_err(internal)?;

        Ok(Response::new(UpdateSessionStateResponse {
            session: Some(updated),
        }))
    }

    async fn cancel_session(
        &self,
        request: Request<CancelSessionRequest>,
    ) -> Result<Response<CancelSessionResponse>, Status> {
        let id = request.into_inner().id;

        let mut conn = self.db_pool.get().await.map_err(internal)?;

        let current: RemotePlaySession = schema::remote_play_sessions::table
            .find(id)
            .select(RemotePlaySession::as_select())
            .first(&mut conn)
            .await
            .optional()
            .map_err(internal)?
            .ok_or_else(|| Status::not_found(format!("remote play session {id} not found")))?;

        let from = RemotePlaySessionState::try_from(current.state)
            .map_err(|_| Status::internal("stored session has an unknown state"))?;

        transition(from, RemotePlaySessionState::Cancelled)
            .map_err(|why| Status::failed_precondition(why.to_string()))?;

        let now = now_ts();
        use schema::remote_play_sessions::dsl;
        let updated: RemotePlaySession = diesel::update(schema::remote_play_sessions::table.find(id))
            .set((
                dsl::state.eq(RemotePlaySessionState::Cancelled as i32),
                dsl::updated_at.eq(Some(now)),
                dsl::ended_at.eq(Some(now)),
            ))
            .get_result(&mut conn)
            .await
            .map_err(internal)?;

        Ok(Response::new(CancelSessionResponse {
            session: Some(updated),
        }))
    }
}
