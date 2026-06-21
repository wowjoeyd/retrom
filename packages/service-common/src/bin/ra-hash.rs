//! Gate command for Phase B (RetroAchievements).
//!
//! Computes the RetroAchievements content hash(es) for a ROM file (via the
//! vendored rcheevos rc_hash) and resolves each to an RA game id through the
//! identification endpoint. Use this to verify hash → game-id correctness on
//! real ROMs across consoles BEFORE the RA provider/UI is built.
//!
//!   cargo run -p retrom-service-common --bin ra-hash -- <path-to-rom>
//!
//! A game id of 0 means the hash is not linked to any RA game ("not identified").

use std::path::Path;
use std::process::ExitCode;

use retrom_service_common::retroachievements::{hash::rc_hash_candidates, resolve_hash_to_game_id};

fn main() -> ExitCode {
    let Some(path_arg) = std::env::args().nth(1) else {
        eprintln!("usage: ra-hash <path-to-rom>");
        return ExitCode::FAILURE;
    };

    let path = Path::new(&path_arg);
    if !path.exists() {
        eprintln!("error: file not found: {path_arg}");
        return ExitCode::FAILURE;
    }

    let candidates = rc_hash_candidates(path);
    println!("File: {path_arg}");

    if candidates.is_empty() {
        println!(
            "No hash could be computed — rc_hash doesn't recognise this file/extension \
             (or it's an unsupported/compressed format like .chd)."
        );
        return ExitCode::SUCCESS;
    }

    println!("Candidate hash(es): {}", candidates.len());

    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(why) => {
            eprintln!("error: failed to start runtime: {why}");
            return ExitCode::FAILURE;
        }
    };

    let client = reqwest::Client::new();
    let mut matched = false;

    for hash in &candidates {
        match rt.block_on(resolve_hash_to_game_id(&client, hash)) {
            Ok(0) => println!("  {hash}  ->  not found (GameID 0)"),
            Ok(id) => {
                matched = true;
                println!("  {hash}  ->  GameID {id}   https://retroachievements.org/game/{id}");
            }
            Err(why) => println!("  {hash}  ->  lookup error: {why}"),
        }
    }

    if matched {
        println!(
            "\nMatched. Confirm the GameID's page on the RA site shows the right game, and \
             that the hash appears under that game's \"Supported Game Files\"."
        );
    } else {
        println!(
            "\nNo candidate resolved. If you expected a match, compare the hash above against \
             the RA game page's \"Supported Game Files\", or RetroArch → Quick Menu → \
             Information → RetroAchievements Hash."
        );
    }

    ExitCode::SUCCESS
}
