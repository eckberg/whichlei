// Where the e2e run serves its fixture index: a second local port, so the page reads it from
// another origin, as it reads the real index.
export const FIXTURE_PORT = 8788;
export const FIXTURE_ORIGIN = `http://127.0.0.1:${FIXTURE_PORT}`;
