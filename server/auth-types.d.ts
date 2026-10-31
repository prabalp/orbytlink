declare module "passport-local" {
  import { Strategy as PassportStrategy } from "passport";
  export class Strategy extends PassportStrategy {
    constructor(
      options: { usernameField: string; passwordField: string },
      verify: (
        username: string,
        password: string,
        done: (error: any, user?: any) => void,
      ) => void,
    );
  }
}
