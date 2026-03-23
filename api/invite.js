import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const CIRCLE_API_TOKEN = process.env.CIRCLE_API_TOKEN;
const CIRCLE_COMMUNITY_ID = process.env.CIRCLE_COMMUNITY_ID;

const TEAMS_MEMBER_TAG_ID = 227713;
const READD_COOLDOWN_MS = 2 * 60 * 60 * 1000;

// Keyed by Stripe product ID — for purchases made via Stripe payment links
// ⚠️ These are LIVE mode product IDs
const COURSE_PRODUCTS = {
  'prod_UAn9cpCjcImRfG': {
    circleSpaceId: 2092678,
    circleTagId: 234453
  },
  'prod_UAn9THENtsnfsm': {
    circleSpaceId: 2092835,
    circleTagId: 234457
  },
  'prod_UAnDez8uy1sZhD': {
    circleSpaceId: 2092837,
    circleTagId: 234456
  },
  'prod_UAnE6jcYX7kICg': {
    circleSpaceId: 2092710,
    circleTagId: 234455
  },
  'prod_UAnBTrYoe3YyOy': {
    circleSpaceId: 2331083,
    circleTagId: 234454
  },
};

// Keyed by Circle paywall ID — for purchases made via Circle paywalls (Zapier bridge)
const CIRCLE_PAYWALL_PRODUCTS = {
  '144287': {
    circleSpaceId: 2092678,
    circleTagId: 234453
  },
  '144288': {
    circleSpaceId: 2092835,
    circleTagId: 234457
  },
  '144289': {
    circleSpaceId: 2331083,
    circleTagId: 234454
  },
  '144291': {
    circleSpaceId: 2092837,
    circleTagId: 234456
  },
  '144292': {
    circleSpaceId: 2092710,
    circleTagId: 234455
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { token, memberEmail, addedByLeader } = req.body;
  if (!token || !memberEmail) {
    return res.status(400).json({ error: 'Token and email are required' });
  }

  const { data: invite, error: inviteError } = await supabase
    .from('invite_tokens')
    .select('*, teams(*)')
    .eq('token', token)
    .eq('used', false)
    .single();

  if (inviteError || !invite) {
    return res.status(400).json({ error: 'Invalid or expired invite token' });
  }

  const team = invite.teams;
  if (team.status !== 'active') {
    return res.status(400).json({ error: 'This team is no longer active' });
  }

  const { count } = await supabase
    .from('team_members')
    .select('id', { count: 'exact' })
    .eq('team_id', team.id)
    .neq('status', 'revoked');

  if (count >= team.seat_limit) {
    return res.status(400).json({ error: 'This team is full. The team leader needs to contact support to add more seats.' });
  }

  const { data: existingMember } = await supabase
    .from('team_members')
    .select('id, status')
    .eq('team_id', team.id)
    .eq('member_email', memberEmail.toLowerCase())
    .neq('status', 'revoked')
    .single();

  if (existingMember) {
    return res.status(400).json({ error: 'This email is already a member of this team' });
  }

  // ---- Subscription flow ----
  if (team.access_type === 'subscription') {
    const { data: revokedMember } = await supabase
      .from('team_members')
      .select('id, revoked_at')
      .eq('team_id', team.id)
      .eq('member_email', memberEmail.toLowerCase())
      .eq('status', 'revoked')
      .single();

    if (revokedMember?.revoked_at) {
      const revokedAt = new Date(revokedMember.revoked_at).getTime();
      const elapsed = Date.now() - revokedAt;
      if (elapsed < READD_COOLDOWN_MS) {
        const minutesRemaining = Math.ceil((READD_COOLDOWN_MS - elapsed) / 60000);
        const hoursRemaining = Math.floor(minutesRemaining / 60);
        const minsLeft = minutesRemaining % 60;
        const timeLeft = hoursRemaining > 0
          ? hoursRemaining + 'h ' + minsLeft + 'm'
          : minsLeft + 'm';
        return res.status(400).json({
          error: 'This member was recently removed. Re-adds are unavailable for 2 hours after removal. Please try again in ' + timeLeft + '.'
        });
      }
    }

    const { circleId, alreadyMember } = await addCircleMember(memberEmail, true);
    const inviteStatus = alreadyMember ? 'active' : (addedByLeader ? 'invited' : 'active');

    if (revokedMember) {
      const { error: updateError } = await supabase
        .from('team_members')
        .update({
          status: 'active',
          invite_status: inviteStatus,
          member_circle_id: circleId,
          revoked_at: null
        })
        .eq('id', revokedMember.id);

      if (updateError) {
        return res.status(500).json({ error: 'Failed to re-add member' });
      }
    } else {
      const { error: insertError } = await supabase
        .from('team_members')
        .insert({
          team_id: team.id,
          member_email: memberEmail.toLowerCase(),
          member_circle_id: circleId,
          status: 'active',
          invite_status: inviteStatus
        });

      if (insertError) {
        return res.status(500).json({ error: 'Failed to add member' });
      }
    }

    return res.status(200).json({ success: true, message: 'You have been added to the team!' });
  }

  // ---- Course flow ----
  if (team.access_type === 'course') {
    // Look up course config — check Stripe product ID first, then Circle paywall ID
    const courseConfig = COURSE_PRODUCTS[team.stripe_product_id] ||
      CIRCLE_PAYWALL_PRODUCTS[team.circle_paywall_id];

    if (!courseConfig) {
      console.error('No course config found for team:', team.id,
        'stripe_product_id:', team.stripe_product_id,
        'circle_paywall_id:', team.circle_paywall_id);
      return res.status(500).json({ error: 'Course configuration not found' });
    }

    const { circleId, alreadyMember } = await addCircleMember(memberEmail, false);

    await addCircleSpaceMember(memberEmail, courseConfig.circleSpaceId);

    if (circleId) {
      await addCircleTag(circleId, courseConfig.circleTagId);
    } else {
      await addCircleTagByEmail(memberEmail, courseConfig.circleTagId);
    }

    const inviteStatus = alreadyMember ? 'active' : (addedByLeader ? 'invited' : 'active');

    const { error: insertError } = await supabase
      .from('team_members')
      .insert({
        team_id: team.id,
        member_email: memberEmail.toLowerCase(),
        member_circle_id: circleId,
        status: 'active',
        invite_status: inviteStatus
      });

    if (insertError) {
      return res.status(500).json({ error: 'Failed to add course team member' });
    }

    return res.status(200).json({ success: true, message: 'You have been added to the course team!' });
  }

  return res.status(400).json({ error: 'Unknown team type' });
}

async function addCircleMember(email, applyTeamsMemberTag) {
  const inviteRes = await fetch(
    'https://app.circle.so/api/admin/v2/community_members',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + CIRCLE_API_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        community_id: parseInt(CIRCLE_COMMUNITY_ID),
        email: email,
        skip_invitation: false
      })
    }
  );

  const inviteData = await inviteRes.json();
  console.log('Circle invite response message:', inviteData?.message);

  const circleId = inviteData?.community_member?.id || null;
  const alreadyMember = inviteData?.message?.includes('already a member');

  console.log('Circle member ID:', circleId, '| Already member:', alreadyMember);

  if (circleId && applyTeamsMemberTag) {
    await addCircleTag(circleId, TEAMS_MEMBER_TAG_ID);
  }

  return { circleId, alreadyMember };
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

async function addCircleTag(memberId, tagId) {
  const getRes = await fetch(
    'https://app.circle.so/api/admin/v2/community_members/' + memberId,
    { headers: { Authorization: 'Bearer ' + CIRCLE_API_TOKEN } }
  );
  const member = await getRes.json();
  const existingTagIds = (member.member_tags || []).map(t => t.id);

  console.log('Existing Circle tags:', existingTagIds);

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
  console.log('Add tag ' + tagId + ' to member ' + memberId + ' - PATCH status: ' + patchRes.status);
}

async function addCircleTagByEmail(email, tagId) {
  const res = await fetch(
    'https://app.circle.so/api/admin/v2/community_members?email=' + encodeURIComponent(email) + '&community_id=' + CIRCLE_COMMUNITY_ID,
    { headers: { Authorization: 'Bearer ' + CIRCLE_API_TOKEN } }
  );
  const data = await res.json();
  const memberId = data?.records?.[0]?.id || null;
  if (!memberId) {
    console.log('Circle member not found for email: ' + email);
    return;
  }
  await addCircleTag(memberId, tagId);
}
