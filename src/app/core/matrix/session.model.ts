/** A persisted Matrix login session, restored on app start to recreate the client. */
export interface MatrixSession {
  baseUrl: string;
  userId: string;
  deviceId: string;
  accessToken: string;
}
