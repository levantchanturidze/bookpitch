'use server';

import { AuthError } from 'next-auth';
import { signIn } from '@/auth';

export type SignInState = { error: string | null };

export async function signInAction(_prev: SignInState, formData: FormData): Promise<SignInState> {
  try {
    await signIn('credentials', {
      email: formData.get('email'),
      password: formData.get('password'),
      redirectTo: '/',
    });
    return { error: null };
  } catch (error) {
    // Auth.js throws AuthError on bad creds; the successful path throws
    // NEXT_REDIRECT which must bubble.
    if (error instanceof AuthError) {
      return { error: 'Invalid email or password.' };
    }
    throw error;
  }
}
