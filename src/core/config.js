// Builds the app config from environment variables (process.env on Node, `env` on Cloudflare).
export function buildConfig(e) {
  const env = (name, fallback = '') => {
    const v = e[name];
    return v === undefined || v === null || v === '' ? fallback : String(v);
  };
  return {
    port: Number(env('PORT', '3000')),
    publicUrl: env('PUBLIC_URL', 'http://localhost:3000').replace(/\/$/, ''),
    adminPassword: env('ADMIN_PASSWORD'),
    dataDir: env('DATA_DIR', './data'),

    // "openai": Twilio call bridged to the OpenAI Realtime API by this app (pay as you go).
    // "elevenlabs": ElevenLabs Agents place the call through the Twilio number imported there.
    voiceProvider: env('VOICE_PROVIDER', 'openai'),
    recordCalls: env('RECORD_CALLS', 'false') === 'true',

    openai: {
      apiKey: env('OPENAI_API_KEY'),
      realtimeUrl: env('OPENAI_REALTIME_URL', 'wss://api.openai.com/v1/realtime'),
      realtimeModel: env('OPENAI_REALTIME_MODEL', 'gpt-realtime-mini'),
      voice: env('OPENAI_VOICE', 'marin'),
      analysisModel: env('OPENAI_ANALYSIS_MODEL', 'gpt-4.1-mini'),
    },

    elevenlabs: {
      apiKey: env('ELEVENLABS_API_KEY'),
      agentId: env('ELEVENLABS_AGENT_ID'),
      phoneNumberId: env('ELEVENLABS_PHONE_NUMBER_ID'),
      webhookSecret: env('ELEVENLABS_WEBHOOK_SECRET'),
    },

    // Shared secret the ElevenLabs agent's tools send in the X-Tool-Secret header.
    toolSecret: env('TOOL_SECRET'),

    seller: {
      agentName: env('AGENT_NAME', 'Alex'),
      yourName: env('YOUR_NAME', ''),
      company: env('YOUR_COMPANY', ''),
      price: env('OFFER_PRICE', ''),
      bookingLink: env('BOOKING_LINK', ''),
      paymentLink: env('PAYMENT_LINK', ''),
    },

    calling: {
      defaultCountryCode: env('DEFAULT_COUNTRY_CODE', '1'),
      defaultTimezone: env('DEFAULT_TIMEZONE', 'America/New_York'),
      windowStartHour: Number(env('CALL_WINDOW_START', '9')),
      windowEndHour: Number(env('CALL_WINDOW_END', '17')),
      // 1 = Monday ... 7 = Sunday
      days: env('CALL_DAYS', '1,2,3,4,5').split(',').map(Number),
      spacingSeconds: Number(env('CALL_SPACING_SECONDS', '90')),
      maxAttempts: Number(env('MAX_ATTEMPTS', '3')),
      maxCallSeconds: Number(env('MAX_CALL_SECONDS', '420')),
    },

    email: {
      from: env('EMAIL_FROM', env('SMTP_FROM')),
      // Resend (https://resend.com) works everywhere, including Cloudflare Workers.
      resendApiKey: env('RESEND_API_KEY'),
      // SMTP works on the Node server only.
      smtp: {
        host: env('SMTP_HOST'),
        port: Number(env('SMTP_PORT', '587')),
        user: env('SMTP_USER'),
        pass: env('SMTP_PASS'),
      },
    },

    // Needed for VOICE_PROVIDER=openai (places the calls) and for texting the demo link.
    // Texting US numbers needs A2P 10DLC registration in Twilio.
    twilio: {
      accountSid: env('TWILIO_ACCOUNT_SID'),
      authToken: env('TWILIO_AUTH_TOKEN'),
      fromNumber: env('TWILIO_FROM_NUMBER'),
    },
  };
}
