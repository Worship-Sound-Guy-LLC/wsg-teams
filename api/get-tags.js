export default async function handler(req, res) {
  const response = await fetch(
    `https://app.circle.so/api/admin/v2/member_tags?community_id=${process.env.CIRCLE_COMMUNITY_ID}`,
    { headers: { Authorization: `Bearer ${process.env.CIRCLE_API_TOKEN}` } }
  );
  const data = await response.json();
  return res.status(200).json(data);
}
