create table remote_play_sessions (
    id integer primary key generated always as identity,
    game_id integer not null,
    host_client_id integer not null,
    client_client_id integer not null,
    state integer not null default 0,
    created_at timestamp with time zone default current_timestamp,
    updated_at timestamp with time zone default current_timestamp,
    started_at timestamp with time zone,
    ended_at timestamp with time zone,
    sunshine_app_name text not null default '',
    error_code text,
    error_message text,
    constraint fk_remote_play_game_id foreign key (
        game_id
    ) references games (id) on delete cascade,
    constraint fk_remote_play_host_client_id foreign key (
        host_client_id
    ) references clients (id) on delete cascade,
    constraint fk_remote_play_client_client_id foreign key (
        client_client_id
    ) references clients (id) on delete cascade
);

alter table clients
add column is_stream_host boolean default false;

alter table clients
add column is_stream_client boolean default false;
