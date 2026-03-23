import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const CIRCLE_API_TOKEN = process.env.CIRCLE_API_TOKEN;
const CIRCLE_COMMUNITY_ID = process.env.CIRCLE_COMMUNITY_ID;

// Keyed by Circle Paywall ID
const CIRCLE_PAYWALL_PRODUCTS = {
  '144287': {
    name: 'Sound Guy Essentials TEAMS ACCESS',
    circleSpaceId: 2092678,
    circleTagId: 234453,
    seatLimit: 5
  },
  '144288': {
    name: 'X32 Masterclass TEAMS ACCESS',
    circleSpaceId: 2092835,
    circleTagId: 234457,
    seatLimit: 5
  },
  '144289': {
    name: 'Sunday Vocal Formula TEAMS ACCESS',
    circleSpaceId: 2331083,
    circleTagId: 234454,
    seatLimit: 5
  },
  '144291': {
    name: 'Drums Masterclass TEAMS ACCESS',
    circleSpaceId: 2092837,
    circleTagId: 234456,
    seatLimit: 5
  },
  '144292': {
    name: 'EQ Secrets Masterclass TEAMS ACCESS',
    circleSpaceId: 2092710,
    circleTagId: 234455,
    seatLimit: 5
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // Verify shared secret from Zapier
  const secret = req.headers['x-zapier-secret'];
  if (!secret || secret !== process.env.ZAPIER_SECRET) {
    console.error('Unauthorized circle-purchase request — invalid or missing secret');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { email, paywallId, circleUserId } = req.body;

  if (!email || !paywallId) {
    console.error('Missing required fields:', { email, paywallId });
    return res.status(400).json({ error: 'email and paywallId are required' });
  }

  // Look up course config by paywall ID
  const course = CIRCLE_PAYWALL_PRODUCTS[String(paywallId)];
  if (!course) {
    console.log('Unknown paywall ID — not a course team product:', paywallId);
    return res.status(200).json({ skipped: true, reason: 'not a course team paywall' });
  }

  const leaderEmail = email.toLowerCase();

  // Check if leader already has an active team for this course
  const { data: existingTeam } = await supabase
    .from('teams')
    .select('id, seat_limit')
    .eq('leader_email', leaderEmail)
    .eq('course_id', course.circleSpaceId)
    .eq('status', 'active')
    .single();

  if (existingTeam) {
    // Increment seat limit and add new invite token
    const newSeatLimit = existingTeam.seat_limit + course.seatLimit;
    await supabase
      .from('teams')
      .update({ seat_limit: newSeatLimit })
      .eq('id', existingTeam.id);

    const newToken = generateToken();
    await supabase.from('invite_tokens').insert({
      team_id: existingTeam.id,
      token: newToken
    });

    console.log('Added ' + course.seatLimit + ' seats to existing course team for ' + leaderEmail + ', new total: ' + newSeatLimit);
    return res.status(200).json({ success: true, action: 'seats_incremented', newSeatLimit });
  }

  // Fresh purchase — create new course team
  const token = generateToken();

  const { data: team, error } = await supabase.from('teams').insert({
    leader_email: leaderEmail,
    stripe_customer_id: null,
    stripe_subscription_id: null,
    access_type: 'course',
    course_id: course.circleSpaceId,
    stripe_product_id: null,
    seat_limit: course.seatLimit,
    status: 'active'
  }).select().single();

  if (error) {
    console.error('Error creating course team:', error);
    return res.status(500).json({ error: 'Failed to create team' });
  }

  // Create invite token
  await supabase.from('invite_tokens').insert({
    team_id: team.id,
    token: token
  });

  // Add leader as first member
  await supabase.from('team_members').insert({
    team_id: team.id,
    member_email: leaderEmail,
    status: 'active',
    invite_status: 'active'
  });

  console.log('Course team created for ' + leaderEmail + ', course: ' + course.name + ', token: ' + token);

  // Add leader to Circle space + apply course teammate tag
  await addCircleSpaceMember(leaderEmail, course.circleSpaceId);
  await addCircleTagByEmail(leaderEmail, course.circleTagId);

  return res.status(200).json({ success: true, action: 'team_created', teamId: team.id });
}

async function addCircleSpaceMember(email, spaceId) {
  const res = await fetch(
    'https://app.circle.so/api/admin/v2/space_members',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + CIRCLE_API_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        community_id: parseInt(CIRCLE_COMMUNITY_ID),
        space_id: spaceId,
        email: email
      })
    }
  );
  const data = await res.json();
  console.log('Add ' + email + ' to space ' + spaceId + ': ' + data?.message);
}

async function getCircleMemberId(email) {
  const res = await fetch(
    'https://app.circle.so/api/admin/v2/community_members?email=' + encodeURIComponent(email) + '&community_id=' + CIRCLE_COMMUNITY_ID,
    { headers: { Authorization: 'Bearer ' + CIRCLE_API_TOKEN } }
  );
  const data = await res.json();
  return data?.records?.[0]?.id || null;
}

async function addCircleTag(memberId, tagId) {
  const getRes = await fetch(
    'https://app.circle.so/api/admin/v2/community_members/' + memberId,
    { headers: { Authorization: 'Bearer ' + CIRCLE_API_TOKEN } }
  );
  const member = await getRes.json();
  const existingTagIds = (member.member_tags || []).map(t => t.id);

  if (existingTagIds.includes(tagId)) {
    console.log('Tag ' + tagId + ' already present on member ' + memberId + ', skipping');
    return;
  }

  const patchRes = await fetch(
    'https://app.circle.so/api/admin/v2/community_members/' + memberId,
    {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer ' + CIRCLE_API_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ member_tag_ids: [...existingTagIds, tagId] })
    }
  );
  console.log('Add tag ' + tagId + ' to member ' + memberId + ' - status: ' + patchRes.status);
}

async function addCircleTagByEmail(email, tagId) {
  const memberId = await getCircleMemberId(email);
  if (!memberId) {
    console.log('Circle member not found for email: ' + email);
    return;
  }
  await addCircleTag(memberId, tagId);
}

function generateToken() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
