import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const CIRCLE_API_TOKEN = process.env.CIRCLE_API_TOKEN;
const CIRCLE_COMMUNITY_ID = process.env.CIRCLE_COMMUNITY_ID;
const TEAMS_PRODUCT_ID = 'prod_U3GrJPneAIsOqB';

const TEAMS_LEADER_TAG_ID = 227715;
const FREE_ACCESS_TAG_ID = 228295;

// A la carte course products map
// ⚠️ These are TEST mode product IDs — replace with live IDs before merging to main
const COURSE_PRODUCTS = {
  'prod_UBSQK5NUmHbbTh': {
    name: 'Sound Guy Essentials TEAMS ACCESS',
    circleSpaceId: 2092678,
    circleTagId: 234453,
    seatLimit: 5
  },
  'prod_UBSRhGp7YG5nJl': {
    name: 'X32 Masterclass TEAMS ACCESS',
    circleSpaceId: 2092835,
    circleTagId: 234457,
    seatLimit: 5
  },
  'prod_UBSRmHzk5b9BiH': {
    name: 'Drums Masterclass TEAMS ACCESS',
    circleSpaceId: 2092837,
    circleTagId: 234456,
    seatLimit: 5
  },
  'prod_UBSRn45VAggtPj': {
    name: 'EQ Secrets Masterclass TEAMS ACCESS',
    circleSpaceId: 2092710,
    circleTagId: 234455,
    seatLimit: 5
  },
  'prod_UBSRodTW44poG0': {
    name: 'Sunday Vocal Formula TEAMS ACCESS',
    circleSpaceId: 2331083,
    circleTagId: 234454,
    seatLimit: 5
  },
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

  const token = generateToken();

  const { data: team, error } = await supabase.from('teams').insert({
    leader_email: leaderEmail,
    stripe_customer_id: session.customer,
    stripe_subscription_id: null,
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
  
  console.log(`Course team created for ${leaderEmail}, course: ${course.name}, token: ${token}`);

  await addCircleSpaceMember(leaderEmail, course.circleSpaceId);
  await addCircleTagByEmail(leaderEmail, course.circleTagId);
}

// ---- Subscription handlers (unchanged) ----

async function handleSubscriptionCreated(subscription) {
  const productId = subscription.items.data[0]?.price?.product;
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

  console.log(`Team created for ${leaderEmail}, token: ${token}`);
  await addCircleTagByEmail(leaderEmail, TEAMS_LEADER_TAG_ID);
}

async function handleSubscriptionDeleted(subscription) {
  const productId = subscription.items.data[0]?.price?.product;
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

  console.log(`Team ${team.id} revoked, ${members?.length || 0} members downgraded`);
}

// ---- Circle API Helpers ----

async function getCircleMemberId(email) {
  const res = await fetch(
    `https://app.circle.so/api/admin/v2/community_members?email=${encodeURIComponent(email)}&community_id=${CIRCLE_COMMUNITY_ID}`,
    { headers: { Authorization: `Bearer ${CIRCLE_API_TOKEN}` } }
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
        Authorization: `Bearer ${CIRCLE_API_TOKEN}`,
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
  console.log(`Add ${email} to space ${spaceId}:`, data?.message);
}

async function addCircleTag(memberId, tagId) {
  const getRes = await fetch(
    `https://app.circle.so/api/admin/v2/community_members/${memberId}`,
    { headers: { Authorization: `Bearer ${CIRCLE_API_TOKEN}` } }
  );
  const member = await getRes.json();
  const existingTagIds = (member.member_tags || []).map(t => t.id);

  console.log('Existing Circle tags:', existingTagIds);

  if (existingTagIds.includes(tagId)) {
    console.log(`Tag ${tagId} already present on member ${memberId}, skipping`);
    return;
  }

  const patchRes = await fetch(
    `https://app.circle.so/api/admin/v2/community_members/${memberId}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${CIRCLE_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ member_tag_ids: [...existingTagIds, tagId] })
    }
  );
  console.log(`Add tag ${tagId} to member ${memberId} - PATCH status:`, patchRes.status);
}

async function applyFreeAccessTag(email, circleIdFromDb) {
  const memberId = circleIdFromDb || await getCircleMemberId(email);
  if (!memberId) {
    console.log(`Circle member not found for email: ${email}`);
    return;
  }

  const patchRes = await fetch(
    `https://app.circle.so/api/admin/v2/community_members/${memberId}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${CIRCLE_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ member_tag_ids: [FREE_ACCESS_TAG_ID] })
    }
  );
  console.log(`Applied FreeAccess tag to member ${memberId} (${email}) - PATCH status:`, patchRes.status);
}

async function addCircleTagByEmail(email, tagId) {
  const memberId = await getCircleMemberId(email);
  if (!memberId) {
    console.log(`Circle member not found for email: ${email}`);
    return;
  }
  await addCircleTag(memberId, tagId);
}

function generateToken() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
