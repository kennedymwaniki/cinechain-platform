import { customType } from 'drizzle-orm/pg-core';

/** Postgres citext: case-insensitive text, used for every e-mail column. */
export const citext = customType<{ data: string }>({ dataType: () => 'citext' });
