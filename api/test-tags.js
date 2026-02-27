export default async function handler(req, res) {
  const memberId = 77709335;
  const tagId = 227713;
  const token = process.env.CIRCLE_API_TOKEN;

  const results = {};

  // Test 1: POST to remove_member_tags
  const r1 = await fetch(
    `https://app.circle.so/api/admin/v2/community_members/${memberId}/remove_member_tags`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag_ids: [tagId] })
    }
  );
  results.test1 = { status: r1.status, body: await r1.text() };

  // Test 2: DELETE on member_tags top-level
  const r2 = await fetch(
    `https://app.circle.so/api/admin/v2/member_tags/${tagId}/community_members/${memberId}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    }
  );
  results.test2 = { status: r2.status, body: await r2.text() };

  return res.status(200).json(results);
}
