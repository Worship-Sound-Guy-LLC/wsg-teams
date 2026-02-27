import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const CIRCLE_API_TOKEN = process.env.CIRCLE_API_TOKEN;
const CIRCLE_COMMUNITY_ID = process.env.CIRCLE_COMMUNITY_ID;
const TEAMS_PRODUCT_ID = 'prod_U2vN9o0joPvgXD';

const TEAMS_MEMBER_TAG_ID = 227713;
const TEAMS_LEADER_TAG_ID = 227715;
const FREE_ACCESS_TAG_ID = 228295;

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

  // Add TeamsLeader tag to leader in Circle (safely, preserving existing tags)
  await addCircleTagByEmail(leaderEmail, TEAMS_LEADER_TAG_ID);
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

  // Remove TeamsMember tag from all members safely (preserving other tags)
  // Circle workflow will automatically downgrade each to Free Access
  if (members?.length) {
    for (const member of members) {
      await removeCircleTagByEmail(member.member_email, TEAMS_MEMBER_TAG_ID);
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

// ---- Circle API Helpers ----

async function getCircleMemberId(email) {
  const res = await fetch(
    `https://app.circle.so/api/admin/v2/community_members?email=${encodeURIComponent(email)}&community_id=${CIRCLE_COMMUNITY_ID}`,
    { headers: { Authorization: `Bearer ${CIRCLE_API_TOKEN}` } }
  );
  const data = await res.json();
  // Circle v2 returns records[], not community_members[]
  return data?.records?.[0]?.id || null;
}

// Safely add a tag by fetching existing tags first and merging
async function addCircleTag(memberId, tagId) {
  // Fetch current member to get existing tags
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

  // PATCH with merged tag list - preserves all existing tags
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

// Safely remove a tag by fetching existing tags first and patching without target tag
async function removeCircleTag(memberId, tagId) {
  // Fetch current member to get existing tags
  const getRes = await fetch(
    `https://app.circle.so/api/admin/v2/community_members/${memberId}`,
    { headers: { Authorization: `Bearer ${CIRCLE_API_TOKEN}` } }
  );
  const member = await getRes.json();
  const existingTagIds = (member.member_tags || []).map(t => t.id);

  console.log('Existing Circle tags before removal:', existingTagIds);

  if (!existingTagIds.includes(tagId)) {
    console.log(`Tag ${tagId} not present on member ${memberId}, skipping`);
    return;
  }

  // PATCH with tag filtered out - preserves all other existing tags
  const remainingTagIds = existingTagIds.filter(id => id !== tagId);

  const patchRes = await fetch(
    `https://app.circle.so/api/admin/v2/community_members/${memberId}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${CIRCLE_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ member_tag_ids: [...remainingTagIds, FREE_ACCESS_TAG_ID] })
    }
  );
  console.log(`Remove tag ${tagId} from member ${memberId} - PATCH status:`, patchRes.status);
}

// Convenience wrappers that look up Circle ID by email first
async function addCircleTagByEmail(email, tagId) {
  const memberId = await getCircleMemberId(email);
  if (!memberId) {
    console.log(`Circle member not found for email: ${email}`);
    return;
  }
  await addCircleTag(memberId, tagId);
}

async function removeCircleTagByEmail(email, tagId) {
  const memberId = await getCircleMemberId(email);
  if (!memberId) {
    console.log(`Circle member not found for email: ${email}`);
    return;
  }
  await removeCircleTag(memberId, tagId);
}

function generateToken() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
