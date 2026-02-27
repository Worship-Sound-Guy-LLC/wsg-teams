export default async function handler(req, res) {
  const token = process.env.CIRCLE_API_TOKEN;
  const r = await fetch(
    'https://app.circle.so/api/admin/v2/member_tags?per_page=50',
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return res.status(200).json(await r.json());
}
