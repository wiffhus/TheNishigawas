export async function onRequest(context) {
  const { request, env } = context;

  // CORSヘッダーの設定
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  // OPTIONSリクエスト(プリフライト)への対応
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (request.method !== 'POST') {
    return new Response('Method not allowed', {
      status: 405,
      headers: corsHeaders
    });
  }

  try {
    const { message, systemPrompt, history, persona } = await request.json();

    let API_KEY;
    
    // ペルソナに応じてAPIキーを選択
    if (persona === 'nishigawas') {
      API_KEY = env.GEMINI_API_KEY_NISHIGAWAS;
    } else {
      API_KEY = env.GOOGLE_API_KEY; // フォールバック
    }

    if (!API_KEY) {
      return new Response(JSON.stringify({ error: `API key not configured for persona: ${persona}` }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 会話履歴をGemini形式に変換
    const contents = [
      { role: 'user', parts: [{ text: systemPrompt }] },
      { role: 'model', parts: [{ text: '承知いたしました。私はミュージカル一家「西側家」として、ルールに従って応答します。' }] }
    ];

    if (history && history.length > 0) {
      history.forEach(msg => {
        contents.push({
          role: msg.role === 'user' ? 'user' : 'model',
          // AIの応答はHTMLを含んでいる可能性があるため、GAS保存用にプレーンテキストを保持
          // ただし、Gemini APIにはプレーンテキスト（または指示通りのマークアップ）を送る
          // index.html側で `dangerouslySetInnerHTML` 用にHTML変換しているので、
          // Geminiに送る履歴は「変換前」のデータであるべきだが、
          // このサンプルでは簡単のため `content` をそのまま送る。
          // STARWARSのサンプルも content をそのまま送っていたので、
          // Gemini側がHTMLタグを解釈できることを期待する。
          // もしGeminiへの履歴送信で問題が出る場合は、履歴の content からHTMLタグを除く処理が必要。
          parts: [{ text: msg.content.replace(/<[^>]*>?/gm, '') }] // 簡易的なHTMLタグ除去
        });
      });
    }

    // 最新のメッセージを追加
    contents.push({ role: 'user', parts: [{ text: message }] });

    // Gemini APIを呼び出し
    const response = await fetch(
      `https://generativelace.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: contents,
          generationConfig: {
            temperature: 1.0, // ミュージカル風の応答のため、創造性を高める
            maxOutputTokens: 2048,
          }
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Gemini API error:', errorText);
      throw new Error(`Gemini API error: ${response.status}`);
    }

    const data = await response.json();
    const aiText = data.candidates?.[0]?.content?.parts?.[0]?.text || '（幕が閉じてしまいました...もう一度お試しください）';

    // Google Apps Script (GAS) に会話内容を非同期で送信
    // env.GAS_WEBAPP_URL が設定されている場合のみ実行
    if (env.GAS_WEBAPP_URL) {
      // context.waitUntil を使うと、レスポンスを返した後も処理を続行できる
      context.waitUntil(
        fetch(env.GAS_WEBAPP_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: message, // ユーザーの質問
            response: aiText, // AIの回答 (HTMLタグなどが含まれる前のテキスト)
            timestamp: new Date().toISOString()
          })
        }).catch(err => {
          // GASへの送信エラーはログに残すだけにし、ユーザーへの応答には影響させない
          console.error('Failed to send data to GAS:', err.message);
        })
      );
    }

    // ユーザー（フロントエンド）に応答を返す
    return new Response(JSON.stringify({ text: aiText }), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
      }
    });

  } catch (error) {
    console.error('Error in Cloudflare Worker:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}
