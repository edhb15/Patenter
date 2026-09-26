export type StoredUser = {
    id: string;
    email: string;
    passwordHash: string;
  };
  
  export type AuthenticatedUser = {
    id: string;
    email: string;
  };