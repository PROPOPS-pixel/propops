/* PropOps page tracker — <2KB, no cookies, no PII, no third-party deps */
(function(){
  var E='/api/analytics/page-track';

  // Detect domain
  var domain=location.hostname.replace(/^www\./,'');

  // Random session ID per page load (not stored, no cookies)
  var sid=Math.random().toString(36).slice(2)+Date.now().toString(36);

  // Device type from UA
  var ua=navigator.userAgent;
  var dev=/Mobi|Android/i.test(ua)?'mobile':/Tablet|iPad/i.test(ua)?'tablet':'desktop';

  // UTM params
  var params=new URLSearchParams(location.search);
  var utm_s=params.get('utm_source');
  var utm_m=params.get('utm_medium');
  var utm_c=params.get('utm_campaign');

  // AU state guess from timezone offset (rough only — no IP lookup, no PII)
  // Most AU traffic comes from same timezone; can't distinguish states without IP
  var region=null;
  try{var tz=Intl.DateTimeFormat().resolvedOptions().timeZone;
    if(tz==='Australia/Sydney'||tz==='Australia/Melbourne'||tz==='Australia/Canberra')region='NSW/VIC';
    else if(tz==='Australia/Brisbane')region='QLD';
    else if(tz==='Australia/Perth')region='WA';
    else if(tz==='Australia/Adelaide')region='SA';
    else if(tz==='Australia/Darwin')region='NT';
    else if(tz==='Australia/Hobart')region='TAS';
    else if(tz)region='AU-other';
  }catch(e){}

  function send(evtype){
    var body={
      domain:domain,
      path:location.pathname,
      referrer:document.referrer||null,
      utm_source:utm_s,utm_medium:utm_m,utm_campaign:utm_c,
      device_type:dev,region:region,session_id:sid,
      event_type:evtype
    };
    if(navigator.sendBeacon){navigator.sendBeacon(E,JSON.stringify(body));}
    else{var x=new XMLHttpRequest();x.open('POST',E,true);x.setRequestHeader('Content-Type','application/json');x.send(JSON.stringify(body));}
  }

  // Fire pageview immediately
  send('pageview');

  // Expose funnel event function for landing page CTAs to call
  window.ppTrack=function(evtype){send(evtype);};
})();
