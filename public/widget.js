/**
 * PropOps Lead Capture Widget
 * Drop this script on any website to capture leads and trigger AI responses.
 *
 * Usage: <script src="https://propops.pro/widget.js"></script>
 */
(function() {
  const API_URL = document.currentScript?.src?.replace('/widget.js', '') || '';

  // Create widget button
  const btn = document.createElement('div');
  btn.id = 'propops-widget-btn';
  btn.innerHTML = '&#9889; Quick Enquiry';
  btn.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#f0a500;color:#0a0e1a;padding:12px 24px;border-radius:30px;cursor:pointer;font-family:sans-serif;font-weight:600;font-size:14px;z-index:9999;box-shadow:0 4px 20px rgba(240,165,0,0.3);transition:all 0.2s;';
  btn.onmouseover = () => btn.style.transform = 'translateY(-2px)';
  btn.onmouseout = () => btn.style.transform = 'translateY(0)';

  // Create form overlay
  const overlay = document.createElement('div');
  overlay.id = 'propops-widget-overlay';
  overlay.style.cssText = 'display:none;position:fixed;bottom:80px;right:24px;width:360px;max-width:calc(100vw - 48px);background:#111827;border:1px solid rgba(255,255,255,0.06);border-radius:16px;z-index:9999;box-shadow:0 16px 48px rgba(0,0,0,0.4);font-family:sans-serif;';

  overlay.innerHTML = `
    <div style="padding:20px;border-bottom:1px solid rgba(255,255,255,0.06)">
      <div style="font-weight:700;color:#fff;font-size:16px;font-family:'Outfit',sans-serif">Property Enquiry</div>
      <div style="color:#94a3b8;font-size:13px;margin-top:4px">We'll respond within seconds</div>
    </div>
    <form id="propops-widget-form" style="padding:20px">
      <input name="name" required placeholder="Your name" style="width:100%;padding:10px 12px;margin-bottom:10px;border-radius:8px;border:1px solid rgba(255,255,255,0.06);background:#1a2035;color:#e2e8f0;font-size:14px;outline:none;font-family:sans-serif">
      <input name="email" type="email" placeholder="Email address" style="width:100%;padding:10px 12px;margin-bottom:10px;border-radius:8px;border:1px solid rgba(255,255,255,0.06);background:#1a2035;color:#e2e8f0;font-size:14px;outline:none;font-family:sans-serif">
      <input name="phone" placeholder="Phone number" style="width:100%;padding:10px 12px;margin-bottom:10px;border-radius:8px;border:1px solid rgba(255,255,255,0.06);background:#1a2035;color:#e2e8f0;font-size:14px;outline:none;font-family:sans-serif">
      <select name="lead_type" style="width:100%;padding:10px 12px;margin-bottom:10px;border-radius:8px;border:1px solid rgba(255,255,255,0.06);background:#1a2035;color:#e2e8f0;font-size:14px;outline:none;font-family:sans-serif;cursor:pointer">
        <option value="">I am a... (select type)</option>
        <option value="buyer">Buyer — looking to purchase</option>
        <option value="renter">Renter — looking to rent</option>
        <option value="seller">Seller — looking to sell</option>
        <option value="landlord">Landlord — need property management</option>
      </select>
      <textarea name="property_interest" placeholder="What property are you interested in?" style="width:100%;padding:10px 12px;margin-bottom:14px;border-radius:8px;border:1px solid rgba(255,255,255,0.06);background:#1a2035;color:#e2e8f0;font-size:14px;outline:none;min-height:60px;resize:vertical;font-family:sans-serif"></textarea>
      <button type="submit" id="propops-widget-submit" style="width:100%;padding:12px;background:#f0a500;color:#0a0e1a;border:none;border-radius:8px;font-weight:600;font-size:14px;cursor:pointer;font-family:sans-serif">Send Enquiry</button>
    </form>
    <div id="propops-widget-success" style="display:none;padding:30px 20px;text-align:center">
      <div style="font-size:32px;margin-bottom:8px">&#10003;</div>
      <div style="color:#fff;font-weight:600;font-size:15px">Enquiry received!</div>
      <div style="color:#94a3b8;font-size:13px;margin-top:6px">Our AI agent is preparing a response right now.</div>
    </div>
  `;

  document.body.appendChild(btn);
  document.body.appendChild(overlay);

  let isOpen = false;
  btn.onclick = () => {
    isOpen = !isOpen;
    overlay.style.display = isOpen ? 'block' : 'none';
    btn.innerHTML = isOpen ? '&times; Close' : '&#9889; Quick Enquiry';
  };

  // Handle form submit
  const form = overlay.querySelector('#propops-widget-form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const submitBtn = overlay.querySelector('#propops-widget-submit');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending...';

    const fd = new FormData(form);
    try {
      const res = await fetch(`${API_URL}/api/leads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: fd.get('name'),
          email: fd.get('email'),
          phone: fd.get('phone'),
          lead_type: fd.get('lead_type') || null,
          property_interest: fd.get('property_interest'),
          source: 'widget'
        })
      });

      if (res.ok) {
        form.style.display = 'none';
        overlay.querySelector('#propops-widget-success').style.display = 'block';
        setTimeout(() => {
          isOpen = false;
          overlay.style.display = 'none';
          btn.innerHTML = '&#9889; Quick Enquiry';
          form.style.display = 'block';
          form.reset();
          overlay.querySelector('#propops-widget-success').style.display = 'none';
          submitBtn.disabled = false;
          submitBtn.textContent = 'Send Enquiry';
        }, 4000);
      }
    } catch (err) {
      submitBtn.textContent = 'Error — Try Again';
      submitBtn.disabled = false;
    }
  };
})();
