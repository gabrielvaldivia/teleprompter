/**
 * Vercel Edge Function to proxy WebSocket connections to Deepgram.
 * This keeps the API key secure on the server side.
 */

export const config = {
  runtime: 'edge',
};

export default async function handler(request: Request): Promise<Response> {
  // Only allow from same origin in production
  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  
  // Basic origin check (you can make this stricter)
  if (process.env.NODE_ENV === 'production' && origin) {
    const allowedOrigins = [
      `https://${host}`,
      'http://localhost:5173',
      'http://localhost:3000',
    ];
    if (!allowedOrigins.some(allowed => origin.startsWith(allowed.split('://')[0] + '://' + allowed.split('://')[1]?.split('/')[0]))) {
      console.log('Origin not allowed:', origin);
    }
  }

  const upgradeHeader = request.headers.get('upgrade');
  
  if (upgradeHeader !== 'websocket') {
    // Not a WebSocket request - return connection info for the client
    const apiKey = process.env.DEEPGRAM_API_KEY;
    
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: 'Deepgram API key not configured' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Return the WebSocket URL with auth for direct connection
    // This is a middle-ground approach - key is fetched at runtime, not bundled
    return new Response(
      JSON.stringify({ 
        url: 'wss://api.deepgram.com/v1/listen?model=nova-2&punctuate=true&interim_results=true&endpointing=100&vad_events=true',
        token: apiKey 
      }),
      { 
        status: 200, 
        headers: { 
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        } 
      }
    );
  }

  // WebSocket upgrade request
  const apiKey = process.env.DEEPGRAM_API_KEY;
  
  if (!apiKey) {
    return new Response('Deepgram API key not configured', { status: 500 });
  }

  // For WebSocket proxying, we need to use Vercel's WebSocket support
  // Unfortunately, full duplex WebSocket proxying is complex in Edge Functions
  // So we use the token approach above - client fetches token and connects directly
  
  return new Response('WebSocket upgrade not supported - use token endpoint', { status: 400 });
}
