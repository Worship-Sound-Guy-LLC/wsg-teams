export default async function handler(req, res) {
  const memberId = 77707675;
  const tagId = 227713;
  const token = process.env.CIRCLE_API_TOKEN;
  const communityId = process.env.CIRCLE_COMMUNITY_ID;

  const results = {};

  // Test 1: POST to add_member_tags
  const r1 = await fetch(
    `https://app.circle.so/api/admin/v2/community_members/${memberId}/add_member_tags`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag_ids: [tagId] })
    }
  );
  results.test1_post_add_member_tags = { status: r1.status, body: await r1.text() };

  // Test 2: PATCH community_member with member_tag_ids
  const r2 = await fetch(
    `https://app.circle.so/api/admin/v2/community_members/${memberId}`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ community_id: parseInt(communityId), member_tag_ids: [tagId] })
    }
  );
  results.test2_patch_member_tag_ids = { status: r2.status, body: await r2.text() };

  // Test 3: PUT with tag_ids array but different body format
  const r3 = await fetch(
    `https://app.circle.so/api/admin/v2/community_members/${memberId}/member_tags`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag_ids: [tagId] })
    }
  );
  results.test3_post_member_tags = { status: r3.status, body: await r3.text() };

  return res.status(200).json(results);
}
