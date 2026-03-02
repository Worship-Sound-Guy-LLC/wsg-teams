// Shared session verification helper
// Validates Supabase access token and confirms the user owns the given teamId

import { createClient } from '@supabase/supabase-js';

export async function verifySession(req, teamId) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { error: 'Unauthorized', status: 401 };
  }

  const accessToken = authHeader.split(' ')[1];
  const supabaseAuth = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

  // Verify the token and get the user
  const { data: { user }, error: authError } = await supabaseAuth.auth.getUser(accessToken);
  if (authError || !user) {
    return { error: 'Unauthorized', status: 401 };
  }

  // If a teamId is provided, confirm this user owns that team
  if (teamId) {
    const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data: team, error: teamError } = await supabaseAdmin
      .from('teams')
      .select('id')
      .eq('id', teamId)
      .eq('leader_email', user.email.toLowerCase())
      .single();

    if (teamError || !team) {
      return { error: 'Forbidden', status: 403 };
    }
  }

  return { user };
}
