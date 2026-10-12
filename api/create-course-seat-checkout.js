import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { verifySession } from './auth-helper.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// One-time $59 additional seat purchase per course — keyed by circle_paywall_id
const COURSE_SEAT_PRICES = {
  144287: { name: 'Sound Guy Essentials — Additional Seat',    priceId: 'price_1UPpha4KkniaK5TvCHlia46o' },
  144288: { name: 'X32 Masterclass — Additional Seat',         priceId: 'price_1UPpiA4KkniaK5Tvflkk0Jaa' },
  144291: { name: 'Drums Masterclass — Additional Seat',       priceId: 'price_1UPpit4KkniaK5TvHUDJ1iHy' },
  144292: { name: 'EQ Secrets Masterclass — Additional Seat',  priceId: 'price_1UPpjR4KkniaK5Tv1aoB1AES' },
  144289: { name: 'Sunday Vocal Formula — Additional Seat',    priceId: 'price_1UPpmQ4KkniaK5TvFnEdl0Zy' },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { teamId } = req.body;
  if (!teamId) return res.status(400).json({ error: 'teamId is required' });

  // Verify the session and confirm the caller owns this team
  const auth = await verifySession(req, teamId);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  const leaderEmail = auth.user.email;

  // Fetch team
  const { data: team, error: teamError } = await supabase
    .from('teams')
    .select('id, seat_limit, status, access_type, circle_paywall_id')
    .eq('id', teamId)
    .single();

  if (teamError || !team) return res.status(404).json({ error: 'Team not found' });
  if (team.status !== 'active') return res.status(400).json({ error: 'Team is not active' });
  if (team.access_type !== 'course') return res.status(400).json({ error: 'Additional seat purchases are for course teams only' });

  const courseConfig = COURSE_SEAT_PRICES[team.circle_paywall_id];
  if (!courseConfig) {
    return res.status(400).json({ error: 'No additional seat product found for this course' });
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: leaderEmail,
    line_items: [{ price: courseConfig.priceId, quantity: 1 }],
    success_url: `${process.env.SITE_URL}/seat-success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.SITE_URL}/dashboard.html`,
    metadata: {
      team_id: teamId,
      leader_email: leaderEmail.toLowerCase(),
      circle_paywall_id: String(team.circle_paywall_id),
      flow: 'course_seat'
    }
  });

  console.log(`Course seat checkout created for team ${teamId} (${courseConfig.name}) — leader: ${leaderEmail}`);
  return res.status(200).json({ checkoutUrl: session.url });
}
