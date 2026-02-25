import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email } = req.query;

  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  // Find all teams where this person is the leader
  const { data: teams, error } = await supabase
    .from('teams')
    .select(`
      id,
      access_type,
      seat_limit,
      status,
      course_space_id,
      converted_from_individual,
      created_at,
      team_members (
        id,
        member_email,
        status,
        joined_at
      ),
      invite_tokens (
        token,
        used
      )
    `)
    .eq('leader_email', email.toLowerCase())
    .eq('status', 'active');

  if (error) {
    console.error('Error fetching teams:', error);
    return res.status(500).json({ error: 'Failed to fetch team data' });
  }

  if (!teams || teams.length === 0) {
    return res.status(404).json({ error: 'No active teams found for this email' });
  }

  // Format the response
  const formattedTeams = teams.map(team => {
    const activeMembers = team.team_members.filter(m => m.status === 'active');
    const inviteToken = team.invite_tokens?.[0]?.token;

    return {
      id: team.id,
      accessType: team.access_type,
      seatLimit: team.seat_limit,
      seatsUsed: activeMembers.length,
      seatsRemaining: team.seat_limit - activeMembers.length,
      status: team.status,
      courseSpaceId: team.course_space_id,
      inviteLink: inviteToken ? `${process.env.SITE_URL}/join?token=${inviteToken}` : null,
      members: activeMembers.map(m => ({
        email: m.member_email,
        joinedAt: m.joined_at
      }))
    };
  });

  return res.status(200).json({ teams: formattedTeams });
}
