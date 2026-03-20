import { useQuery } from '@tanstack/react-query';
import { authApi } from '@/lib/api-client';
import type { CurrentUser } from '@/lib/auth';

export function useCurrentUser() {
  return useQuery<CurrentUser>({
    queryKey: ['auth', 'me'],
    queryFn: authApi.me,
    staleTime: 5 * 60 * 1000,  // re-fetch at most every 5 min
    retry: false,
  });
}
