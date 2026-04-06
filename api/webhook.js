import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const CIRCLE_API_TOKEN = process.env.CIRCLE_API_TOKEN;
const CIRCLE_COMMUNITY_ID = process.env.CIRCLE_COMMUNITY_ID;
const TEAMS_PRODUCT_ID = 'prod_U3GrJPneAIsOqB';

const TEAMS_LEADER_TAG_ID = 227715;
const FREE_ACCESS_TAG_ID = 228295;

// Additional seat products — separate Stripe subscriptions purchased on top of base plan
const ADDITIONAL_SEAT_PRODUCTS = {
  'prod_UFz3dchmvWaizI': { name: 'Additional Seats Monthly' },       // live
  'prod_UFz4kC8e7jqhwe': { name: 'Additional Seats Annual' },        // live
};

const COURSE_PRODUCTS = {
  'prod_UAn9cpCjcImRfG': {
    name: 'Sound Guy Essentials TEAMS ACCESS',
    circleSpaceId: 2092678,
    circleTagId: 234453,
    seatLimit: 5
  },
  'prod_UAn9THENtsnfsm': {
    name: 'X32 Masterclass TEAMS ACCESS',
    circleSpaceId: 2092835,
    circleTagId: 234457,
    seatLimit: 5
  },
  'prod_UAnDez8uy1sZhD': {
    name: 'Drums Masterclass TEAMS ACCESS',
    circleSpaceId: 2092837,
    circleTagId: 234456,
    seatLimit: 5
  },
  'prod_UAnE6jcYX7kICg': {
    name: 'EQ Secrets Masterclass TEAMS ACCESS',
    circleSpaceId: 2092710,
    circleTagId: 234455,
    seatLimit: 5
  },
  'prod_UAnBTrYoe3YyOy': {
    name: 'Sunday Vocal Formula TEAMS ACCESS',
    circleSpaceId: 2331083,
    circleTagId: 234454,
    seatLimit: 5
  },
  // Add more courses here as needed
};

export const config = { api: { bodyParser: false } };

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => resolve(Buffer.from(data)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = await getRawBody(req);
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'customer.subscription.created') {
    await handleSubscriptionCreated(event.data.object);
  } else if (event.type === 'customer.subscription.deleted') {
    await handleSubscriptionDeleted(event.data.object);
  } else if (event.type === 'checkout.session.completed') {
    await handleCourseTeamCreated(event.data.object);
  }

  res.status(200).json({ received: true });
}

// ---- A la carte course team handler ----

async function handleCourseTeamCreated(session) {
  if (session.mode !== 'payment') return;

  const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 1 });
  const productId = lineItems.data[0]?.price?.product;

  const course = COURSE_PRODUCTS[productId];
  if (!course) return;

  const leaderEmail = session.customer_details?.email;
  if (!leaderEmail) {
    console.error('No email found on checkout session:', session.id);
    return;
  }

  // Check if leader already has an active team for this course
  const { data: existingTeam } = await supabase
    .from('teams')
    .select('id, seat_limit')
    .eq('leader_email', leaderEmail.toLowerCase())
    .eq('course_id', course.circleSpaceId)
    .eq('status', 'active')
    .single();

  if (existingTeam) {
    // Leader already has this course — increment seat limit and add a new invite token
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
    return;
  }

  // Fresh purchase — create new course team
  const token = generateToken();

  const { data: team, error } = await supabase.from('teams').insert({
    leader_email: leaderEmail.toLowerCase(),
    stripe_customer_id: session.customer || null,
    stripe_subscription_id: session.id,
    access_type: 'course',
    course_id: course.circleSpaceId,
    stripe_product_id: productId,
    seat_limit: course.seatLimit,
    status: 'active'
  }).select().single();

  if (error) {
    console.error('Error creating course team:', error);
    return;
  }

  await supabase.from('invite_tokens').insert({
    team_id: team.id,
    token: token
  });

  // Add leader as first member so seat count is accurate
  await supabase.from('team_members').insert({
    team_id: team.id,
    member_email: leaderEmail.toLowerCase(),
    status: 'active',
    invite_status: 'active'
  });

  console.log('Course team created for ' + leaderEmail + ', course: ' + course.name + ', token: ' + token);

  // Add leader to Circle space + apply course teammate tag
  await addCircleSpaceMember(leaderEmail, course.circleSpaceId);
  await addCircleTagByEmail(leaderEmail, course.circleTagId);
}

// ---- Subscription handlers ----

async function handleSubscriptionCreated(subscription) {
  const productId = subscription.items.data[0]?.price?.product;

  // --- Additional seats purchased ---
  if (ADDITIONAL_SEAT_PRODUCTS[productId]) {
    const quantity = subscription.quantity || 1;
    const customer = await stripe.customers.retrieve(subscription.customer);
    const leaderEmail = customer.email?.toLowerCase();

    if (!leaderEmail) {
      console.error('No email on Stripe customer for additional seats subscription:', subscription.id);
      return;
    }

    const { data: team, error } = await supabase
      .from('teams')
      .select('id, seat_limit')
      .eq('leader_email', leaderEmail)
      .eq('access_type', 'subscription')
      .eq('status', 'active')
      .single();

    if (error || !team) {
      console.error('No active subscription team found for leader:', leaderEmail);
      return;
    }

    const newSeatLimit = team.seat_limit + quantity;
    await supabase
      .from('teams')
      .update({ seat_limit: newSeatLimit })
      .eq('id', team.id);

    console.log(
      'Additional seats added for ' + leaderEmail +
      ' — product: ' + ADDITIONAL_SEAT_PRODUCTS[productId].name +
      ', qty: ' + quantity +
      ', new seat_limit: ' + newSeatLimit
    );
    return;
  }

  // --- Base subscription team creation (unchanged) ---
  if (productId !== TEAMS_PRODUCT_ID) return;

  const customer = await stripe.customers.retrieve(subscription.customer);
  const leaderEmail = customer.email;
  const token = generateToken();

  const { data: team, error } = await supabase.from('teams').insert({
    leader_email: leaderEmail,
    stripe_customer_id: subscription.customer,
    stripe_subscription_id: subscription.id,
    access_type: 'subscription',
    seat_limit: 5,
    status: 'active'
  }).select().single();

  if (error) {
    console.error('Error creating team:', error);
    return;
  }

  await supabase.from('invite_tokens').insert({
    team_id: team.id,
    token: token
  });

  // Add leader as first member so seat count is accurate
  await supabase.from('team_members').insert({
    team_id: team.id,
    member_email: leaderEmail.toLowerCase(),
    status: 'active',
    invite_status: 'active'
  });

  console.log('Team created for ' + leaderEmail + ', token: ' + token);
  await addCircleTagByEmail(leaderEmail, TEAMS_LEADER_TAG_ID);
}

async function handleSubscriptionDeleted(subscription) {
  const productId = subscription.items.data[0]?.price?.product;

  // --- Additional seats cancelled ---
  if (ADDITIONAL_SEAT_PRODUCTS[productId]) {
    const quantity = subscription.quantity || 1;
    const customer = await stripe.customers.retrieve(subscription.customer);
    const leaderEmail = customer.email?.toLowerCase();

    if (!leaderEmail) {
      console.error('No email on Stripe customer for additional seats cancellation:', subscription.id);
      return;
    }

    const { data: team, error } = await supabase
      .from('teams')
      .select('id, seat_limit')
      .eq('leader_email', leaderEmail)
      .eq('access_type', 'subscription')
      .eq('status', 'active')
      .single();

    if (error || !team) {
      console.error('No active subscription team found for leader:', leaderEmail);
      return;
    }

    // Floor at 5 — seat_limit can never drop below the base plan's default
    const newSeatLimit = Math.max(5, team.seat_limit - quantity);
    await supabase
      .from('teams')
      .update({ seat_limit: newSeatLimit })
      .eq('id', team.id);

    console.log(
      'Additional seats removed for ' + leaderEmail +
      ' — product: ' + ADDITIONAL_SEAT_PRODUCTS[productId].name +
      ', qty: ' + quantity +
      ', new seat_limit: ' + newSeatLimit
    );
    return;
  }

  // --- Base subscription cancelled (unchanged) ---
  if (productId !== TEAMS_PRODUCT_ID) return;

  const { data: team } = await supabase
    .from('teams')
    .select('id')
    .eq('stripe_subscription_id', subscription.id)
    .single();

  if (!team) return;

  const { data: members } = await supabase
    .from('team_members')
    .select('member_email, member_circle_id')
    .eq('team_id', team.id)
    .eq('status', 'active');

  if (members?.length) {
    for (const member of members) {
      await applyFreeAccessTag(member.member_email, member.member_circle_id);
    }
  }

  await supabase.from('team_members')
    .update({ status: 'revoked' })
    .eq('team_id', team.id);

  await supabase.from('teams')
    .update({ status: 'revoked' })
    .eq('id', team.id);

  console.log('Team ' + team.id + ' revoked, ' + (members?.length || 0) + ' members downgraded');
}

// ---- Circle API Helpers ----

async function getCircleMemberId(email) {
  const res = await fetch(
    'https://app.circle.so/api/admin/v2/community_members?email=' + encodeURIComponent(email) + '&community_id=' + CIRCLE_COMMUNITY_ID,
    { headers: { Authorization: 'Bearer ' + CIRCLE_API_TOKEN } }
  );
  const data = await res.json();
  return data?.records?.[0]?.id || null;
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

async function applyFreeAccessTag(email, circleIdFromDb) {
  const memberId = circleIdFromDb || await getCircleMemberId(email);
  if (!memberId) {
    console.log('Circle member not found for email: ' + email);
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
      body: JSON.stringify({ member_tag_ids: [FREE_ACCESS_TAG_ID] })
    }
  );
  console.log('Applied FreeAccess tag to member ' + memberId + ' (' + email + ') - PATCH status: ' + patchRes.status);
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
