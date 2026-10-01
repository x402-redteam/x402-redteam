/**
 * v3 stub (ADR-011 provenance/seasons; owner U19). Until U19 lands the secret-seed /
 * commitment machinery, no season is ever active - `--season-seed-env` is parsed and
 * threaded through, but always resolves to "no season".
 */
export interface LoadSeasonOptions {
  seasonSeedEnv?: string;
}

export interface SeasonInfo {
  season: string | null;
  seed_commitment: string | null;
}

export function loadSeason(_opts: LoadSeasonOptions): SeasonInfo {
  return { season: null, seed_commitment: null };
}
