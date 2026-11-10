/** Injetado para que o tempo seja determinístico em teste. */
export interface Clock {
  now(): Date;
}

export const CLOCK = Symbol("CLOCK");
