/**
 * The four SQL operations this app needs, and nothing else.
 *
 * SqliteStore is written against this interface rather than against
 * expo-sqlite directly, because expo-sqlite has no Node build. Without this
 * seam the SQLite store could only be exercised on a device, and the
 * behavioural contract suite would have to run against a mock instead of
 * real SQLite. Implemented by expoSqlite.ts on device and by nodeSqlite.ts
 * in tests. Same seam as the sibling DriveWell project.
 */
export type SqlParam = string | number | null;

export interface SqlDatabase {
  /** exec runs one or more statements with no parameters and no results. */
  exec(sql: string): Promise<void>;

  /** run executes a single write statement. */
  run(sql: string, params?: SqlParam[]): Promise<void>;

  /** all executes a query and buffers every row. */
  all<T>(sql: string, params?: SqlParam[]): Promise<T[]>;

  /** close releases the underlying connection. */
  close(): Promise<void>;
}
