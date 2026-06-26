alter table clients
drop column is_stream_client;

alter table clients
drop column is_stream_host;

drop table remote_play_sessions;
