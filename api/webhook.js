import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const CIRCLE_API_TOKEN = process.env.CIRCLE_API_TOKEN;
const CIRCLE_COMMUNITY_ID = process.env.CIRCLE_COMMUNITY_ID;
const TEAMS_PRODUCT_ID = 'prod_U2vN9o0joPvgXD';

const TEAMS_MEMBER_TAG_ID = 227713;
const TEAMS_LEADER_TAG_ID = 227715;

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
  }

  res.status(200).json({ received: true });
}

async function handleSubscriptionCreated(subscription) {
  const productId = subscription.items.data[0]?.price?.product;
  if (productId !== TEAMS_PRODUCT_ID) return;

  const customer = await stripe.customers.retrieve(subscription.customer);
  const leaderEmail = customer.email;
  const token = generateToken();

  // Create team in Supabase
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

  // Create invite token
  await supabase.from('invite_tokens').insert({
    team_id: team.id,
    token: token
  });

  console.log(`Team created for ${leaderEmail}, token: ${token}`);

  // Add TeamsLeader tag to leader in Circle
  await addCircleTag(leaderEmail, TEAMS_LEADER_TAG_ID);
}

async function handleSubscriptionDeleted(subscription) {
  const productId = subscription.items.data[0]?.price?.product;
  if (productId !== TEAMS_PRODUCT_ID) return;

  // Find the team
  const { data: team } = await supabase
    .from('teams')
    .select('id')
    .eq('stripe_subscription_id', subscription.id)
    .single();

  if (!team) return;

  // Get all active members
  const { data: members } = await supabase
    .from('team_members')
    .select('member_email')
    .eq('team_id', team.id)
    .eq('status', 'active');

  // Remove TeamsMember tag from all members
  // Circle workflow will automatically downgrade each to Free Access
  if (members?.length) {
    for (const member of members) {
      await removeCircleTag(member.member_email, TEAMS_MEMBER_TAG_ID);
    }
  }

  // Revoke all members and team in Supabase
  await supabase.from('team_members')
    .update({ status: 'revoked' })
    .eq('team_id', team.id);

  await supabase.from('teams')
    .update({ status: 'revoked' })
    .eq('id', team.id);

  console.log(`Team ${team.id} revoked, ${members?.length || 0} members downgraded`);
}

async function getCircleMemberId(email) {
  const res = await fetch(
    `https://app.circle.so/api/admin/v2/community_members?email=${encodeURIComponent(email)}&community_id=${CIRCLE_COMMUNITY_ID}`,
    { headers: { Authorization: `Bearer ${CIRCLE_API_TOKEN}` } }
  );
  const data = await res.json();
  return data?.records?.[0]?.id || null;
}

async function addCircleTag(email, tagId) {
  const memberId = await getCircleMemberId(email);
  if (!memberId) {
    console.log(`Circle member not found for email: ${email}`);
    return;
  }

  const res = await fetch(
    `https://app.circle.so/api/admin/v2/community_members/${memberId}/member_tags`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${CIRCLE_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ tag_ids: [tagId] })
    }
  );
  console.log(`Tag ${tagId} added to ${email}, status:`, res.status);
}

async function removeCircleTag(email, tagId) {
  const memberId = await getCircleMemberId(email);
  if (!memberId) {
    console.log(`Circle member not found for email: ${email}`);
    return;
  }

  const res = await fetch(
    `https://app.circle.so/api/admin/v2/community_members/${memberId}/member_tags/${tagId}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${CIRCLE_API_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  );
  console.log(`Tag ${tagId} removed from ${email}, status:`, res.status);
}

function generateToken() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
