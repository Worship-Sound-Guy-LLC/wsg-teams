import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import getRawBody from 'raw-body';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const CIRCLE_API_TOKEN = process.env.CIRCLE_API_TOKEN;
const CIRCLE_COMMUNITY_ID = process.env.CIRCLE_COMMUNITY_ID;

// Your Stripe product IDs - update these to match your actual product IDs
const TEAM_SUBSCRIPTION_PRODUCT_ID = 'prod_U2vN9o0joPvgXD';
const INDIVIDUAL_SUBSCRIPTION_PRODUCT_ID = 'prod_U2vMxPzXlXydBn';

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sig = req.headers['stripe-signature'];
  let event;

  const rawBody = await getRawBody(req);

  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  try {
    switch (event.type) {
      case 'customer.subscription.created':
        await handleSubscriptionCreated(event.data.object);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object);
        break;
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object);
        break;
      default:
        console.log(`Unhandled event type: ${event.type}`);
    }
  } catch (err) {
    console.error('Error processing webhook:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }

  return res.status(200).json({ received: true });
}

async function handleSubscriptionCreated(subscription) {
  const productId = subscription.items.data[0]?.price?.product;
  
  if (productId !== TEAM_SUBSCRIPTION_PRODUCT_ID) {
    console.log('Not a team subscription, skipping');
    return;
  }

  const customer = await stripe.customers.retrieve(subscription.customer);
  const leaderEmail = customer.email;

  // Generate invite token
  const inviteToken = crypto.randomBytes(32).toString('hex');

  // Create team record in Supabase
  const { data: team, error } = await supabase
    .from('teams')
    .insert({
      leader_email: leaderEmail,
      stripe_customer_id: subscription.customer,
      stripe_subscription_id: subscription.id,
      access_type: 'subscription',
      seat_limit: 5,
      status: 'active'
    })
    .select()
    .single();

  if (error) {
    console.error('Error creating team:', error);
    throw error;
  }

  // Create invite token
  await supabase.from('invite_tokens').insert({
    team_id: team.id,
    token: inviteToken,
    used: false
  });

  // Tag leader in Circle
  await tagCircleMember(leaderEmail, 'team-leader-subscription');

  console.log(`Team created for ${leaderEmail}, token: ${inviteToken}`);
}

async function handleSubscriptionDeleted(subscription) {
  const { data: team, error: teamError } = await supabase
    .from('teams')
    .select('id')
    .eq('stripe_subscription_id', subscription.id)
    .single();

  if (teamError || !team) {
    console.log('No team found for subscription:', subscription.id);
    return;
  }

  // Get all active members
  const { data: members } = await supabase
    .from('team_members')
    .select('id, member_email, member_circle_id')
    .eq('team_id', team.id)
    .eq('status', 'active');

  // Remove each member from Circle
  for (const member of members || []) {
    await removeCircleMember(member.member_circle_id);
  }

  // Revoke all members in Supabase
  await supabase
    .from('team_members')
    .update({ status: 'revoked' })
    .eq('team_id', team.id);

  // Revoke the team itself
  const { error: updateError } = await supabase
    .from('teams')
    .update({ status: 'revoked' })
    .eq('id', team.id);

  if (updateError) {
    console.error('Error revoking team:', updateError);
    throw updateError;
  }

  console.log(`Team ${team.id} revoked, ${members?.length || 0} members removed`);
}

async function handleSubscriptionUpdated(subscription) {
  const productId = subscription.items.data[0]?.price?.product;
  
  // Check if this is an upgrade from individual to team
  if (productId === TEAM_SUBSCRIPTION_PRODUCT_ID) {
    const { data: existingTeam } = await supabase
      .from('teams')
      .select('id')
      .eq('stripe_subscription_id', subscription.id)
      .single();

    if (!existingTeam) {
      // New team from upgrade - treat like a new subscription
      const updatedSub = { ...subscription, customer: subscription.customer };
      await handleSubscriptionCreated(updatedSub);
      
      // Mark as converted from individual
      await supabase
        .from('teams')
        .update({ converted_from_individual: true, converted_at: new Date().toISOString() })
        .eq('stripe_subscription_id', subscription.id);
    }
  }
}

async function tagCircleMember(email, tagSlug) {
  // First find the member by email
  const searchRes = await fetch(
    `https://app.circle.so/api/admin/v2/community_members?email=${encodeURIComponent(email)}&community_id=${CIRCLE_COMMUNITY_ID}`,
    { headers: { Authorization: `Bearer ${CIRCLE_API_TOKEN}` } }
  );
  const searchData = await searchRes.json();
  const member = searchData?.community_members?.[0];

  if (!member) {
    console.log(`Circle member not found for email: ${email}`);
    return;
  }

  await fetch(
    `https://app.circle.so/api/admin/v2/community_members/${member.id}/member_tags`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${CIRCLE_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ tag_slugs: [tagSlug] })
    }
  );
}

async function removeCircleMember(circleId) {
  if (!circleId) return;
  
  await fetch(
    `https://app.circle.so/api/admin/v2/community_members/${circleId}?community_id=${CIRCLE_COMMUNITY_ID}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${CIRCLE_API_TOKEN}` }
    }
  );
}
