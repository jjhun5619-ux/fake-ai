const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
//  Supabase
// ============================================================
let supabase = null;
let supabaseAdmin = null;

function initSupabase(config) {
    if (!config?.url || !config?.anon || !config?.service) {
        console.log('⚠️ Supabase 설정이 필요합니다.');
        return false;
    }
    supabase = createClient(config.url, config.anon);
    supabaseAdmin = createClient(config.url, config.service);
    console.log('✅ Supabase 연결 완료!');
    return true;
}

if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    initSupabase({
        url: process.env.SUPABASE_URL,
        anon: process.env.SUPABASE_ANON_KEY,
        service: process.env.SUPABASE_SERVICE_ROLE_KEY
    });
}

app.use(cors({
    origin: ['http://localhost:3000', 'https://chat.enn.kr'],
    credentials: true
}));
app.use(express.json());
app.use(express.static('public'));

// ============================================================
//  미들웨어
// ============================================================
async function verifyToken(token) {
    if (!supabaseAdmin) return null;
    try {
        const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
        if (error || !user) return null;
        return user;
    } catch (e) {
        return null;
    }
}

async function isAdmin(token) {
    if (!supabase) return false;
    const user = await verifyToken(token);
    if (!user) return false;
    const { data } = await supabase
        .from('profiles')
        .select('is_admin')
        .eq('id', user.id)
        .single();
    return data?.is_admin || false;
}

// ============================================================
//  Supabase 설정 저장
// ============================================================
app.post('/api/supabase/config', (req, res) => {
    const { url, anon, service } = req.body;
    if (!url || !anon || !service) {
        return res.status(400).json({ error: 'Supabase 설정이 필요합니다.' });
    }
    const success = initSupabase({ url, anon, service });
    if (success) {
        res.json({ success: true, message: '✅ Supabase 연결 완료!' });
    } else {
        res.status(500).json({ error: 'Supabase 연결 실패' });
    }
});

// ============================================================
//  인증 API
// ============================================================
app.post('/api/auth/register', async (req, res) => {
    const { email, password, username, supabase: supabaseConfig } = req.body;
    
    if (supabaseConfig && !supabase) {
        initSupabase(supabaseConfig);
    }
    
    if (!supabaseAdmin) {
        return res.status(500).json({ error: 'Supabase가 연결되지 않았습니다.' });
    }

    if (!email || !password) {
        return res.status(400).json({ error: '이메일과 비밀번호는 필수입니다.' });
    }

    try {
        const { data, error } = await supabaseAdmin.auth.signUp({
            email, password,
            options: { data: { username: username || email.split('@')[0] } }
        });
        if (error) throw error;
        res.json({
            success: true,
            token: data.session?.access_token,
            user: { email, username: username || email.split('@')[0] }
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password, supabase: supabaseConfig } = req.body;
    
    if (supabaseConfig && !supabase) {
        initSupabase(supabaseConfig);
    }
    
    if (!supabaseAdmin) {
        return res.status(500).json({ error: 'Supabase가 연결되지 않았습니다.' });
    }

    if (!email || !password) {
        return res.status(400).json({ error: '이메일과 비밀번호를 입력해주세요.' });
    }

    try {
        const { data, error } = await supabaseAdmin.auth.signInWithPassword({ email, password });
        if (error) throw error;
        
        await supabase
            .from('profiles')
            .update({ last_login: new Date().toISOString() })
            .eq('id', data.user.id);

        const { data: profile } = await supabase
            .from('profiles')
            .select('is_admin')
            .eq('id', data.user.id)
            .single();

        res.json({
            success: true,
            token: data.session.access_token,
            user: {
                email: data.user.email,
                username: data.user.user_metadata?.username || email.split('@')[0],
                isAdmin: profile?.is_admin || false
            }
        });
    } catch (err) {
        res.status(401).json({ error: '이메일 또는 비밀번호가 잘못되었습니다.' });
    }
});

// ============================================================
//  게스트
// ============================================================
app.post('/api/guest/start', async (req, res) => {
    if (!supabase) {
        return res.status(500).json({ error: 'Supabase가 연결되지 않았습니다.' });
    }
    const sessionId = 'guest_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const { error } = await supabase
        .from('guest_sessions')
        .insert({
            session_id: sessionId,
            remaining: 10,
            expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString()
        });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, sessionId, remaining: 10 });
});

app.post('/api/guest/status', async (req, res) => {
    if (!supabase) {
        return res.json({ active: false, remaining: 0 });
    }
    const { sessionId } = req.body;
    const { data, error } = await supabase
        .from('guest_sessions')
        .select('remaining, expires_at')
        .eq('session_id', sessionId)
        .single();
    if (error || !data) return res.json({ active: false, remaining: 0 });
    const isExpired = new Date(data.expires_at) < new Date();
    if (isExpired) {
        await supabase.from('guest_sessions').delete().eq('session_id', sessionId);
        return res.json({ active: false, remaining: 0 });
    }
    res.json({ active: true, remaining: data.remaining });
});

// ============================================================
//  템플릿 CRUD
// ============================================================
app.post('/api/templates', async (req, res) => {
    const { token, name, content, icon } = req.body;
    const user = await verifyToken(token);
    if (!user) return res.status(401).json({ error: '인증 실패' });

    const { data: profile } = await supabase
        .from('profiles')
        .select('templates')
        .eq('id', user.id)
        .single();

    let templates = profile?.templates || [];
    const existing = templates.find(t => t.name === name);
    if (existing) {
        existing.content = content;
        existing.icon = icon || '📝';
        existing.updatedAt = new Date().toISOString();
    } else {
        templates.push({
            id: Date.now(),
            name,
            content,
            icon: icon || '📝',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            usageCount: 0
        });
    }

    await supabase
        .from('profiles')
        .update({ templates })
        .eq('id', user.id);

    res.json({ success: true, templates });
});

app.post('/api/templates/list', async (req, res) => {
    const { token } = req.body;
    const user = await verifyToken(token);
    if (!user) return res.status(401).json({ error: '인증 실패' });
    const { data } = await supabase
        .from('profiles')
        .select('templates')
        .eq('id', user.id)
        .single();
    res.json({ templates: data?.templates || [] });
});

// ============================================================
//  학습 피드백
// ============================================================
app.post('/api/training/feedback', async (req, res) => {
    const { token, userMessage, aiResponse, rating, mode, sessionId } = req.body;

    let userId = null;
    let isAdminUser = false;

    if (token) {
        const user = await verifyToken(token);
        if (user) {
            userId = user.id;
            isAdminUser = await isAdmin(token);
        }
    }

    const { error } = await supabase
        .from('training_data')
        .insert({
            user_id: userId,
            user_message: userMessage,
            ai_response: aiResponse,
            rating: rating || 3,
            mode: mode || 'fake',
            is_admin: isAdminUser,
            quality: rating >= 4 ? 'high' : 'medium',
            is_training_data: true
        });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// ============================================================
//  학습 시스템 (admin)
// ============================================================
app.post('/api/learning/admin', async (req, res) => {
    const { token, userMessage, aiResponse, mode, rating } = req.body;
    const user = await verifyToken(token);
    if (!user) return res.status(401).json({ error: '인증 실패' });

    const isAdminUser = await isAdmin(token);
    if (!isAdminUser) return res.status(403).json({ error: '관리자만 접근 가능합니다.' });

    const { error } = await supabase
        .from('training_data')
        .insert({
            user_id: user.id,
            user_message: userMessage,
            ai_response: aiResponse,
            rating: rating || 5,
            mode: mode || 'fakecodev2',
            is_admin: true,
            quality: rating >= 4 ? 'high' : 'medium',
            is_training_data: true
        });

    if (error) return res.status(500).json({ error: error.message });

    const { count } = await supabase
        .from('training_data')
        .select('*', { count: 'exact', head: true })
        .eq('is_admin', true)
        .eq('quality', 'high');

    res.json({
        success: true,
        message: '🧠 학습 데이터가 저장되었습니다!',
        stats: { adminData: count || 0 }
    });
});

app.post('/api/learning/stats', async (req, res) => {
    const { token } = req.body;
    const user = await verifyToken(token);
    if (!user) return res.status(401).json({ error: '인증 실패' });

    const isAdminUser = await isAdmin(token);
    if (!isAdminUser) return res.status(403).json({ error: '관리자만 접근 가능합니다.' });

    const { data: allData, count: total } = await supabase
        .from('training_data')
        .select('*', { count: 'exact' });

    const { count: adminCount } = await supabase
        .from('training_data')
        .select('*', { count: 'exact', head: true })
        .eq('is_admin', true);

    const { count: highCount } = await supabase
        .from('training_data')
        .select('*', { count: 'exact', head: true })
        .eq('quality', 'high');

    const { data: ratings } = await supabase
        .from('training_data')
        .select('rating');

    const avgRating = ratings && ratings.length > 0
        ? ratings.reduce((s, r) => s + (r.rating || 3), 0) / ratings.length
        : 0;

    const { data: modeData } = await supabase
        .from('training_data')
        .select('mode');

    const modeDist = {};
    (modeData || []).forEach(d => {
        const mode = d.mode || 'fake';
        modeDist[mode] = (modeDist[mode] || 0) + 1;
    });

    res.json({
        stats: {
            total: total || 0,
            adminData: adminCount || 0,
            highQuality: highCount || 0,
            avgRating: Math.round(avgRating * 10) / 10,
            modeDistribution: modeDist,
            lastUpdated: allData && allData.length > 0 ? allData[allData.length - 1].created_at : null
        }
    });
});

// ============================================================
//  Claude 4.8
// ============================================================
app.post('/api/claude48/ask', async (req, res) => {
    const { token, question } = req.body;
    const user = await verifyToken(token);
    if (!user) return res.status(401).json({ error: '인증 실패' });

    const isAdminUser = await isAdmin(token);
    if (!isAdminUser) return res.status(403).json({ error: '🔒 Claude 4.8은 관리자 전용입니다.' });

    const { data: adminData } = await supabase
        .from('training_data')
        .select('user_message, ai_response, quality, rating')
        .eq('is_admin', true)
        .eq('quality', 'high')
        .order('rating', { ascending: false })
        .limit(100);

    if (!adminData || adminData.length === 0) {
        return res.json({
            version: 'Claude 4.8 (Pre-release)',
            response: '📚 아직 학습 데이터가 부족합니다.',
            dataCount: 0,
            progress: '0%'
        });
    }

    const keywords = question.split(' ');
    let matches = [];
    adminData.forEach(d => {
        const userWords = d.user_message.split(' ');
        let score = 0;
        keywords.forEach(k => {
            if (userWords.some(w => w.includes(k) || k.includes(w))) score++;
        });
        if (score > 0) matches.push({ data: d, score, quality: d.quality === 'high' ? 1.5 : 1.0 });
    });

    matches.sort((a, b) => (b.score * b.quality) - (a.score * a.quality));

    let response = '';
    if (matches.length > 0) {
        const top = matches.slice(0, 3);
        response = `🧠 **Claude 4.8** (PAKE-ai 기반)\n\n`;
        response += `💡 **주요 응답**\n${top[0].data.ai_response}\n\n`;
        if (top.length > 1) {
            response += `📌 **추가 인사이트**\n${top[1].data.ai_response}\n\n`;
        }
        response += `🔍 **종합 분석**\n`;
        response += `- 관련 데이터: ${matches.length}개\n`;
        response += `- 신뢰도: ${Math.round((top[0].score / keywords.length) * 100)}%\n`;
        response += `- Claude 4.8 진행률: ${Math.min(100, Math.round((adminData.length / 10000) * 100))}%\n\n`;
        response += `---\n✨ *Claude 4.8은 PAKE-ai의 학습 데이터로 구동됩니다.*`;
    } else {
        response = `🧠 **Claude 4.8**\n\n` +
                  `아직 이 주제에 대한 학습이 충분하지 않습니다.\n` +
                  `admin님의 고품질 대화가 더 필요합니다! 💪\n\n` +
                  `📊 현재 학습 데이터: ${adminData.length}개\n` +
                  `🎯 목표: 10,000개 (Claude 4.8 정식 출시)`;
    }

    res.json({
        version: 'Claude 4.8',
        response,
        dataCount: adminData.length,
        progress: Math.min(100, Math.round((adminData.length / 10000) * 100)) + '%',
        poweredBy: 'PAKE-ai Brain v2.0'
    });
});

app.post('/api/claude48/progress', async (req, res) => {
    const { token } = req.body;
    const user = await verifyToken(token);
    if (!user) return res.status(401).json({ error: '인증 실패' });

    const { count } = await supabase
        .from('training_data')
        .select('*', { count: 'exact', head: true })
        .eq('is_admin', true)
        .eq('quality', 'high');

    const dataCount = count || 0;
    const progress = Math.min(100, Math.round((dataCount / 10000) * 100));
    const remaining = Math.max(0, 10000 - dataCount);

    res.json({
        project: 'Claude 4.8 Development',
        status: progress >= 100 ? '✅ 완료!' : '🚧 개발 중',
        progress,
        dataCount,
        targetData: 10000,
        remainingData: remaining,
        estimatedRelease: progress >= 100 ? '지금 바로!' : `${Math.ceil(remaining / 50)}일 후`,
        version: progress >= 100 ? 'Claude 4.8.0' : `Claude 4.8.${Math.floor(progress / 10)}`,
        poweredBy: 'PAKE-ai Brain'
    });
});

// ============================================================
//  기증
// ============================================================
app.post('/api/claude48/donate', async (req, res) => {
    const { token } = req.body;
    const user = await verifyToken(token);
    if (!user) return res.status(401).json({ error: '인증 실패' });

    const isAdminUser = await isAdmin(token);
    if (!isAdminUser) return res.status(403).json({ error: '관리자만 가능합니다.' });

    const { count } = await supabase
        .from('training_data')
        .select('*', { count: 'exact', head: true })
        .eq('is_admin', true)
        .eq('quality', 'high');

    if ((count || 0) < 10000) {
        return res.json({
            success: false,
            message: `아직 Claude 4.8이 완성되지 않았습니다. (${count || 0}/10000)`,
            progress: Math.round(((count || 0) / 10000) * 100) + '%'
        });
    }

    const letter = `
📜 **To: Anthropic Team**

Subject: Donation of Claude 4.8 - An Advanced AI Model

Dear Anthropic Team,

We are proud to announce the development of Claude 4.8, 
an advanced AI model built by the PAKE-ai community.

After months of dedicated work and over 10,000 high-quality 
conversations, we have created a model that we believe 
represents the next step in AI evolution.

Key Features:
- Enhanced reasoning capabilities
- Natural conversation flow
- Korean language optimization
- PAKE-ai Brain technology

We would like to donate this model to the Claude project 
as a token of our appreciation for your groundbreaking work.

We hope this contribution helps advance AI for the benefit 
of all humanity.

Sincerely,
PAKE-ai Team

---
Data Points: ${count || 0}+
Quality Rating: 4.8/5
Development Period: 30 days
`;

    await supabase
        .from('donation_logs')
        .insert({
            admin_id: user.id,
            data_count: count || 0,
            letter: letter
        });

    res.json({
        success: true,
        message: '🎉 Claude 4.8이 성공적으로 기증되었습니다!',
        letter,
        donationId: Date.now()
    });
});

// ============================================================
//  👑 admin 채팅 영구 저장
// ============================================================
app.post('/api/admin/chats/save', async (req, res) => {
    const { token, chatId, messages, mode, title } = req.body;

    const user = await verifyToken(token);
    if (!user) return res.status(401).json({ error: '인증 실패' });

    const isAdminUser = await isAdmin(token);
    if (!isAdminUser) return res.status(403).json({ error: '관리자만 사용 가능합니다.' });

    try {
        const { data: existing } = await supabase
            .from('admin_chats')
            .select('id')
            .eq('user_id', user.id)
            .eq('chat_id', chatId)
            .single();

        if (existing) {
            const { error } = await supabase
                .from('admin_chats')
                .update({
                    messages: messages,
                    mode: mode,
                    title: title || '새 대화',
                    updated_at: new Date().toISOString()
                })
                .eq('user_id', user.id)
                .eq('chat_id', chatId);
            if (error) throw error;
        } else {
            const { error } = await supabase
                .from('admin_chats')
                .insert({
                    user_id: user.id,
                    chat_id: chatId,
                    messages: messages,
                    mode: mode,
                    title: title || '새 대화'
                });
            if (error) throw error;
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/chats/load', async (req, res) => {
    const { token } = req.body;

    const user = await verifyToken(token);
    if (!user) return res.status(401).json({ error: '인증 실패' });

    const isAdminUser = await isAdmin(token);
    if (!isAdminUser) return res.status(403).json({ error: '관리자만 사용 가능합니다.' });

    try {
        const { data, error } = await supabase
            .from('admin_chats')
            .select('*')
            .eq('user_id', user.id)
            .order('updated_at', { ascending: false });

        if (error) throw error;
        res.json({ chats: data || [] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  📊 admin 대시보드
// ============================================================
app.post('/api/admin/dashboard', async (req, res) => {
    const { token } = req.body;

    const user = await verifyToken(token);
    if (!user) return res.status(401).json({ error: '인증 실패' });

    const isAdminUser = await isAdmin(token);
    if (!isAdminUser) return res.status(403).json({ error: '관리자만 사용 가능���니다.' });

    try {
        const { data: trainingData, count: totalTraining } = await supabase
            .from('training_data')
            .select('*', { count: 'exact' });

        const { count: highQualityCount } = await supabase
            .from('training_data')
            .select('*', { count: 'exact', head: true })
            .eq('is_admin', true)
            .eq('quality', 'high');

        const today = new Date().toISOString().split('T')[0];
        const { count: todayCount } = await supabase
            .from('training_data')
            .select('*', { count: 'exact', head: true })
            .gte('created_at', today);

        const { count: chatCount } = await supabase
            .from('admin_chats')
            .select('*', { count: 'exact' })
            .eq('user_id', user.id);

        const { data: modeStats } = await supabase
            .from('training_data')
            .select('mode');

        const modeDist = {};
        (modeStats || []).forEach(d => {
            const mode = d.mode || 'fake';
            modeDist[mode] = (modeDist[mode] || 0) + 1;
        });

        const { data: ratings } = await supabase
            .from('training_data')
            .select('rating');

        const avgRating = ratings && ratings.length > 0
            ? ratings.reduce((s, r) => s + (r.rating || 3), 0) / ratings.length
            : 0;

        const progress = Math.min(100, Math.round(((highQualityCount || 0) / 10000) * 100));

        res.json({
            dashboard: {
                totalTraining: totalTraining || 0,
                highQualityData: highQualityCount || 0,
                todayData: todayCount || 0,
                chatCount: chatCount || 0,
                avgRating: Math.round(avgRating * 10) / 10,
                modeDistribution: modeDist,
                claude48: {
                    progress: progress,
                    dataCount: highQualityCount || 0,
                    target: 10000,
                    status: progress >= 100 ? '✅ 완료!' : '🚧 개발 중'
                },
                lastUpdated: new Date().toISOString()
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  채팅 저장/불러오기 (일반)
// ============================================================
app.post('/api/chats', async (req, res) => {
    const { token, chats } = req.body;
    const user = await verifyToken(token);
    if (!user) return res.status(401).json({ error: '인증 실패' });
    await supabase.from('profiles').update({ chats }).eq('id', user.id);
    res.json({ success: true });
});

app.post('/api/chats/load', async (req, res) => {
    const { token } = req.body;
    const user = await verifyToken(token);
    if (!user) return res.status(401).json({ error: '인증 실패' });
    const { data } = await supabase.from('profiles').select('chats').eq('id', user.id).single();
    res.json({ chats: data?.chats || [] });
});

// ============================================================
//  사용자 정보
// ============================================================
app.post('/api/user/info', async (req, res) => {
    const { token } = req.body;
    const user = await verifyToken(token);
    if (!user) return res.status(401).json({ error: '인증 실패' });

    const { data: profile } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .single();

    if (!profile) return res.status(404).json({ error: '프로필을 찾을 수 없습니다.' });

    const today = new Date().toISOString().split('T')[0];
    const dailyUsage = profile.daily_usage || {};
    const used = dailyUsage[today] || 0;
    const remaining = Math.max(0, 5 - used);

    res.json({
        user: {
            email: user.email,
            username: profile.username,
            isAdmin: profile.is_admin || false,
            profile,
            createdAt: profile.created_at,
            lastLogin: profile.last_login,
            chatCount: (profile.chats || []).length,
            templates: profile.templates || [],
            dailyUsage: { today, used, remaining, maxPerDay: 5 }
        }
    });
});

app.post('/api/usage', async (req, res) => {
    const { token } = req.body;
    const user = await verifyToken(token);
    if (!user) return res.status(401).json({ error: '인증 실패' });

    const { data: profile } = await supabase
        .from('profiles')
        .select('daily_usage, is_admin')
        .eq('id', user.id)
        .single();

    if (!profile) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });

    const today = new Date().toISOString().split('T')[0];
    const dailyUsage = profile.daily_usage || {};
    const used = dailyUsage[today] || 0;
    const remaining = Math.max(0, 5 - used);

    res.json({ today, used, remaining, maxPerDay: 5, isAdmin: profile.is_admin || false });
});

// ============================================================
//  🔥 Claude 호출 (OpenAPIs 프록시 - 무료!)
// ============================================================
app.post('/api/claude/stream', async (req, res) => {
    const { model, messages, mode, token, sessionId } = req.body;

    const modeMap = {
        'fake': 'claude-haiku-4-5',
        'fakecode': 'claude-sonnet-4-6',
        'fakecodev2': 'claude-opus-4-7'
    };
    const modelName = modeMap[mode] || 'claude-haiku-4-5';

    let userId = null;
    let isAdminUser = false;

    if (token) {
        const user = await verifyToken(token);
        if (user) {
            userId = user.id;
            isAdminUser = await isAdmin(token);
        }
    }

    // FakeCode v2 제한
    if (mode === 'fakecodev2' && !isAdminUser) {
        if (!userId) {
            return res.status(403).json({
                error: '🔒 FakeCode v2는 로그인 후 사용 가능합니다.',
                code: 'login_required'
            });
        }

        const { data: profile } = await supabase
            .from('profiles')
            .select('daily_usage')
            .eq('id', userId)
            .single();

        const today = new Date().toISOString().split('T')[0];
        const dailyUsage = profile?.daily_usage || {};
        const used = dailyUsage[today] || 0;

        if (used >= 5) {
            return res.status(429).json({
                error: '⛔ 오늘 FakeCode v2 사용 횟수를 모두 소진했습니다. (5회/일)',
                code: 'daily_limit'
            });
        }

        dailyUsage[today] = used + 1;
        await supabase
            .from('profiles')
            .update({ daily_usage: dailyUsage })
            .eq('id', userId);
    }

    // 게스트 처리
    if (!token && sessionId) {
        const { data: guest } = await supabase
            .from('guest_sessions')
            .select('remaining')
            .eq('session_id', sessionId)
            .single();

        if (!guest || guest.remaining <= 0) {
            return res.status(403).json({
                error: '게스트 체험 횟수가 모두 소진되었습니다.',
                code: 'guest_limit'
            });
        }

        await supabase
            .from('guest_sessions')
            .update({ remaining: guest.remaining - 1 })
            .eq('session_id', sessionId);
    }

    // 프롬프트
    let systemPrompt = '';
    switch (mode) {
        case 'fake':
            systemPrompt = 'You are PAKE-ai (Fake mode). Friendly, warm, casual AI for everyday life. Respond in Korean.';
            break;
        case 'fakecode':
            systemPrompt = 'You are PAKE-ai (FakeCode mode). Coding assistant. Help with code, debugging, technical questions. Respond in Korean.';
            break;
        case 'fakecodev2':
            systemPrompt = 'You are PAKE-ai (FakeCode v2). Most powerful AI. Complex reasoning, advanced coding, mathematics, deep analysis. Respond in Korean.';
            break;
        default:
            systemPrompt = 'You are PAKE-ai, a helpful AI assistant. Respond in Korean.';
    }

    const finalMessages = [{ role: 'user', content: systemPrompt }, ...messages];

    try {
        // 🔥 OpenAPIs 프록시 (완전 무료!)
        const response = await fetch('https://api.openapis.online/anthropic/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': 'admin',
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: modelName,
                max_tokens: 4096,
                temperature: 0.7,
                messages: finalMessages
            })
        });

        if (!response.ok) {
            const err = await response.text();
            return res.status(response.status).json({ error: err });
        }

        const data = await response.json();
        const reply = data.content?.[0]?.text || '(응답이 없습니다)';

        // 스트리밍처럼 응답 (한 번에)
        res.json({ content: reply });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
//  리다이렉트
// ============================================================
app.get('/go/enn', (req, res) => { res.redirect('https://chat.enn.kr'); });

// ============================================================
//  서버 시작
// ============================================================
app.listen(PORT, () => {
    console.log(`🚀 Fake-ai Server on http://localhost:${PORT}`);
    console.log(`📦 Supabase: ${supabase ? '연결됨 ✅' : '대기 중 (프론트에서 설정 필요) ⏳'}`);
    console.log(`🌿 Fake = Claude 3.5 (Haiku) - 일상생활 (무제한)`);
    console.log(`💻 FakeCode = Claude Free (Sonnet) - 코딩 2번째 (무제한)`);
    console.log(`🧠 FakeCode v2 = Claude 4.7 (Opus) - 코딩 최강 (하루 5회)`);
    console.log(`🚀 OpenAPIs 프록시로 무료 Claude 4.7 사용 중!`);
});
