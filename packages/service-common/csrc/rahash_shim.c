/* Thin C shim over rcheevos rc_hash so Rust never has to mirror the
 * `rc_hash_iterator` struct layout. Enumerates every candidate RetroAchievements
 * content hash for a file (the iterator yields one per plausible console, which
 * the caller then resolves against the RA server until one matches a game).
 *
 * `out` is a caller-provided buffer of `max` * 33 bytes; each 33-byte slot holds
 * one NUL-terminated 32-char hex hash. Returns the number of hashes written. */
#include <string.h>
#include "rc_hash.h"

int retrom_rc_hash_file(const char* path, char* out, int max) {
  struct rc_hash_iterator iterator;
  char hash[33];
  int count = 0;

  /* Register rc_hash's built-in disc reader. Without this, rc_cd_open_track has
   * "no hook registered" and ALL disc hashing (PS1/PS2/PSP/Saturn/Sega CD/
   * PCE-CD/GameCube — .cue/.iso/.bin) fails. The file reader auto-initialises,
   * but the cd reader does not. Idempotent, so calling per invocation is fine. */
  rc_hash_init_default_cdreader();

  rc_hash_initialize_iterator(&iterator, path, NULL, 0);
  while (count < max && rc_hash_iterate(hash, &iterator)) {
    memcpy(out + (size_t)count * 33, hash, 33);
    ++count;
  }
  rc_hash_destroy_iterator(&iterator);

  return count;
}
