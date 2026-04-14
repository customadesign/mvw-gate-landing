const crypto = require('crypto');

function sha256(value) {
  return crypto.createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}

function generateEventId() {
  return `mvw_gate_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { name, email, phone, details, utm_source, utm_medium, utm_campaign, utm_content, fbc, fbp } = req.body || {};

  if (!name || !email || !phone) {
    return res.status(400).json({ error: 'Name, email, and phone are required.' });
  }

  const GHL_API_KEY = process.env.GHL_API_KEY;
  const FB_PIXEL_ID = '2361317594373464';
  const FB_CAPI_TOKEN = process.env.FB_CAPI_TOKEN;
  const LOCATION_ID = '3WV5jH9Duzz5eJJ22O5V';
  const eventId = generateEventId();

  const nameParts = name.trim().split(/\s+/);
  const firstName = nameParts[0];
  const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';

  try {
    // Create or update contact in GHL
    const contactRes = await fetch(
      'https://services.leadconnectorhq.com/contacts/upsert',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GHL_API_KEY}`,
          'Version': '2021-07-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          locationId: LOCATION_ID,
          firstName,
          lastName,
          email,
          phone,
          tags: ['dig-set-go gate', 'gate consultation', ...(utm_campaign ? ['paid traffic'] : [])],
          source: 'Gate Landing Page',
          customFields: [
            { id: 'OJtw3r4TzZhseA7JeZi5', value: utm_source  || '' },
            { id: 'baFRfbakhrauDvFAV9ym', value: utm_medium  || '' },
            { id: 'IgnocyXFC05b1GVNSVhx', value: utm_campaign || '' },
            { id: '9OR3WvGnVrKT8IKNgQSA', value: utm_content  || '' },
          ],
        }),
      }
    );

    if (!contactRes.ok) {
      const errBody = await contactRes.text();
      console.error('GHL contact upsert failed:', contactRes.status, errBody);
      return res.status(502).json({ error: 'Failed to create contact.' });
    }

    const contactData = await contactRes.json();
    const contactId = contactData.contact?.id;

    // Create opportunity in GHL pipeline
    if (contactId) {
      await fetch('https://services.leadconnectorhq.com/opportunities/', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GHL_API_KEY}`,
          'Version': '2021-07-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          pipelineId: 'EiAJ2T0SMI1YXjTC39wq',
          pipelineStageId: 'eb4e9bbb-daf4-4edf-a976-46943541c0eb',
          locationId: LOCATION_ID,
          contactId,
          name: `${name} — Dig Set Go Gate Inquiry`,
          status: 'open',
          monetaryValue: 16000,
          source: 'Gate Landing Page',
        }),
      });
    }

    // Add property details as a note
    const utmLine = [
      utm_source && `Source: ${utm_source}`,
      utm_medium && `Medium: ${utm_medium}`,
      utm_campaign && `Campaign: ${utm_campaign}`,
      utm_content && `Ad ID: ${utm_content}`,
    ].filter(Boolean).join(' | ');

    if ((details || utmLine) && contactId) {
      const noteBody = [
        details && `Gate consultation request:\n\n${details}`,
        utmLine && `Ad Attribution — ${utmLine}`,
      ].filter(Boolean).join('\n\n');

      await fetch(
        `https://services.leadconnectorhq.com/contacts/${contactId}/notes`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${GHL_API_KEY}`,
            'Version': '2021-07-28',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ body: noteBody }),
        }
      ).catch(err => console.error('GHL note creation failed:', err));
    }

    // Fire Facebook Conversions API
    if (FB_CAPI_TOKEN) {
      const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.headers['x-real-ip'] || '';
      const userAgent = req.headers['user-agent'] || '';

      const userData = {
        em: [sha256(email)],
        ph: [sha256(phone.replace(/\D/g, ''))],
        client_ip_address: clientIp,
        client_user_agent: userAgent,
      };
      if (fbc) userData.fbc = fbc;
      if (fbp) userData.fbp = fbp;

      fetch(`https://graph.facebook.com/v21.0/${FB_PIXEL_ID}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: [{
            event_name: 'Lead',
            event_time: Math.floor(Date.now() / 1000),
            action_source: 'website',
            event_source_url: req.headers['referer'] || 'https://info.mvweldingco.com',
            event_id: eventId,
            user_data: userData,
          }],
          access_token: FB_CAPI_TOKEN,
        }),
      }).catch(err => console.error('CAPI error:', err));
    }

    return res.status(200).json({ success: true, contactId, eventId });
  } catch (err) {
    console.error('GHL API error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
};
