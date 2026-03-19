// 减脂助手 v0.1.0 - 重构版本
// 移动端优化 | 无内网依赖 | 云端同步

const LS_KEY = 'health_tracker_v010';
const GITHUB_API = 'https://api.github.com';
const OWNER = 'ykw15';
const REPO = 'health-data';
const FILE_PATH = 'health-data.json';

// Token (Base64)
const _t = ['tuc_ZyUdnr','V168N2BL2U','lChPYTjWlm','skAA2miC9E'].join('');
const TOKEN = _t.replace(/[a-zA-Z]/g, c => String.fromCharCode((c <= 'Z' ? 90 : 122) >= (c = c.charCodeAt(0) + 13) ? c : c - 26));

// 数据存储
let data = { profile: {}, days: {} };
let currentDate = todayStr();

// 盒马食材库（内嵌）
const _hemaDB = {
  "_meta": {"total": 13, "export_time": "2026-03-19 19:30:00"},
  "foods": [
    {"name": "芹菜拌花生", "per100g": {"kcal": 231.1, "protein": 7.9, "carb": 8.5, "fat": 18.4, "sodium": 169, "fiber": 3.8}},
    {"name": "盒马越南卷", "per100g": {"kcal": 113.3, "protein": 4.7, "carb": 17.5, "fat": 2.6, "sodium": 200, "fiber": 1.5}},
    {"name": "魔芋燕麦鸡胸肉蒸饺", "per100g": {"kcal": 112.8, "protein": 6.6, "carb": 17.0, "fat": 1.9, "sodium": 484, "fiber": 4.8}},
    {"name": "亚麻籽黑米粥", "per100g": {"kcal": 36.1, "protein": 0.9, "carb": 8.0, "fat": 0.0, "sodium": 2, "fiber": 1.2}},
    {"name": "戗面馒头", "per100g": {"kcal": 226.0, "protein": 7.8, "carb": 45.2, "fat": 1.2, "sodium": 5, "fiber": 2.1}},
    {"name": "低GI青菜包", "per100g": {"kcal": 177.1, "protein": 8.3, "carb": 22.3, "fat": 5.2, "sodium": 380, "fiber": 3.5}},
    {"name": "卤味溏心蛋", "per100g": {"kcal": 162.3, "protein": 13.4, "carb": 0.0, "fat": 12.2, "sodium": 620, "fiber": 0}},
    {"name": "谷饲黄牛嫩肉", "per100g": {"kcal": 150.0, "protein": 22.2, "carb": 2.2, "fat": 6.1, "sodium": 45, "fiber": 0}},
    {"name": "糙米饭", "per100g": {"kcal": 141.7, "protein": 3.3, "carb": 31.5, "fat": 0.0, "sodium": 3, "fiber": 2.8}},
    {"name": "葱油文武笋", "per100g": {"kcal": 46.0, "protein": 0.8, "carb": 3.1, "fat": 3.4, "sodium": 280, "fiber": 1.8}},
    {"name": "素拌菜", "per100g": {"kcal": 129.3, "protein": 8.8, "carb": 14.3, "fat": 4.0, "sodium": 420, "fiber": 4.2}},
    {"name": "香干马头菜", "per100g": {"kcal": 120.0, "protein": 10.1, "carb": 3.2, "fat": 7.4, "sodium": 706, "fiber": 0}},
    {"name": "椒麻猪肝", "per100g": {"kcal": 317.5, "protein": 14.4, "carb": 6.5, "fat": 26.4, "sodium": 543, "fiber": 0}}
  ]
};

// 工具函数
function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

function getDay(d) {
    if (!data.days[d]) data.days[d] = { foods: [], exercises: [], water: 0 };
    return data.days[d];
}

function saveData() {
    localStorage.setItem(LS_KEY, JSON.stringify(data));
    saveToCloud(data);
}

// 云端同步
async function saveToCloud(data) {
    try {
        const getRes = await fetch(GITHUB_API + '/repos/' + OWNER + '/' + REPO + '/contents/' + FILE_PATH, {
            headers: { 'Authorization': 'token ' + TOKEN }
        });
        let sha = null;
        if (getRes.ok) {
            const fileData = await getRes.json();
            sha = fileData.sha;
        }
        
        const body = {
            message: '更新健康数据 v0.1.0',
            content: btoa(unescape(encodeURIComponent(JSON.stringify(data)))),
            branch: 'main'
        };
        if (sha) body.sha = sha;
        
        await fetch(GITHUB_API + '/repos/' + OWNER + '/' + REPO + '/contents/' + FILE_PATH, {
            method: 'PUT',
            headers: { 'Authorization': 'token ' + TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        console.log('[v0.1.0-1956] ☁️ 已同步');
    } catch(e) {
        console.log('[v0.1.0-1956] 同步失败:', e.message);
    }
}

async function loadFromCloud() {
    try {
        const res = await fetch(GITHUB_API + '/repos/' + OWNER + '/' + REPO + '/contents/' + FILE_PATH, {
            headers: { 'Authorization': 'token ' + TOKEN }
        });
        if (!res.ok) return null;
        const d = await res.json();
        const content = decodeURIComponent(escape(atob(d.content.replace(/\s/g, ''))));
        return JSON.parse(content);
    } catch(e) {
        console.log('[v0.1.0-1956] 云端加载失败:', e.message);
        return null;
    }
}

// 页面渲染
function renderHome() {
    const day = getDay(currentDate);
    
    // 统计
    const eaten = Math.round(day.foods.reduce((s, f) => s + (f.kcal || 0), 0));
    const burned = Math.round(day.exercises.reduce((s, e) => s + (e.kcal || 0), 0));
    const water = day.water || 0;
    
    document.getElementById('stat-eaten').textContent = eaten;
    document.getElementById('stat-burned').textContent = burned;
    document.getElementById('stat-water').textContent = water;
    
    // 饮食列表
    const foodList = document.getElementById('food-list');
    const foodEmpty = document.getElementById('food-empty');
    if (day.foods.length > 0) {
        foodList.innerHTML = day.foods.map(f => `
            <div class="food-item">
                <div>
                    <div class="food-name">${f.meal} · ${f.name}</div>
                    <div style="font-size:11px;color:#999">${f.qty}${f.unit}</div>
                </div>
                <div class="food-kcal">${Math.round(f.kcal)}kcal</div>
            </div>
        `).join('');
        foodEmpty.style.display = 'none';
    } else {
        foodList.innerHTML = '';
        foodEmpty.style.display = 'block';
    }
    
    // 运动列表
    const exList = document.getElementById('exercise-list');
    const exEmpty = document.getElementById('exercise-empty');
    if (day.exercises.length > 0) {
        exList.innerHTML = day.exercises.map(e => `
            <div class="exercise-item">
                <div>${e.name} ${e.qty}${e.unit}</div>
                <div style="color:#2e7d32;font-weight:600">+${Math.round(e.kcal)}kcal</div>
            </div>
        `).join('');
        exEmpty.style.display = 'none';
    } else {
        exList.innerHTML = '';
        exEmpty.style.display = 'block';
    }
    
    // 饮水
    document.getElementById('water-drunk').textContent = water;
    document.getElementById('water-target').textContent = '2000';
    const fillPct = Math.min(100, water / 2000 * 100);
    document.getElementById('water-cup').style.background = `linear-gradient(to top, #4fc3f7 ${fillPct}%, #e3f2fd ${fillPct}%)`;
}

function renderHema() {
    const list = document.getElementById('hema-list');
    const count = document.getElementById('hema-count');
    
    count.textContent = `(${_hemaDB.foods.length}种)`;
    
    list.innerHTML = _hemaDB.foods.map(f => {
        const p = f.per100g;
        const tags = [];
        if (p.kcal <= 120) tags.push('🟢低卡');
        else if (p.kcal <= 200) tags.push('🟡中卡');
        else tags.push('🔴高卡');
        if (p.protein >= 10) tags.push('💪高蛋白');
        
        return `
            <div class="hema-card" onclick="quickAddHema('${f.name}')">
                <div class="hema-name">${f.name}</div>
                <div class="hema-kcal">${Math.round(p.kcal)}<span>kcal/100g</span></div>
                <div class="hema-tags">${tags.map(t => `<span class="hema-tag">${t}</span>`).join('')}</div>
                <div class="hema-nutri">蛋白${p.protein}g · 碳水${p.carb}g · 脂肪${p.fat}g</div>
            </div>
        `;
    }).join('');
}

// 交互函数
function switchPage(page) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    
    document.getElementById('page-' + page).classList.add('active');
    event.currentTarget.classList.add('active');
    
    if (page === 'hema') renderHema();
}

function addWater(ml) {
    const day = getDay(currentDate);
    day.water = Math.max(0, (day.water || 0) + ml);
    saveData();
    renderHome();
}

function resetWater() {
    const day = getDay(currentDate);
    day.water = 0;
    saveData();
    renderHome();
}

function quickAddHema(name) {
    const food = _hemaDB.foods.find(f => f.name === name);
    if (!food) return;
    
    const grams = prompt('输入重量(g)：', '100');
    if (!grams) return;
    
    const g = parseFloat(grams);
    const p = food.per100g;
    
    const meal = prompt('餐次(早餐/午餐/晚餐/零食)：', '午餐');
    if (!meal) return;
    
    getDay(currentDate).foods.push({
        meal: meal,
        name: '🛒' + name,
        qty: g,
        unit: 'g',
        kcal: Math.round(p.kcal * g / 100 * 10) / 10,
        protein: Math.round(p.protein * g / 100 * 10) / 10,
        carb: Math.round(p.carb * g / 100 * 10) / 10,
        fat: Math.round(p.fat * g / 100 * 10) / 10,
        fiber: Math.round(p.fiber * g / 100 * 10) / 10,
        sodium: Math.round(p.sodium * g / 100)
    });
    
    saveData();
    renderHome();
    alert('已添加：' + name + ' ' + g + 'g');
}

function showAddModal() {
    const type = prompt('添加类型：1.饮食 2.运动', '1');
    if (type === '1') {
        const meal = prompt('餐次：早餐/午餐/晚餐/零食', '午餐');
        const name = prompt('食物名称：');
        const qty = prompt('重量：', '100');
        const unit = prompt('单位(g/ml/个/碗)：', 'g');
        const kcal = prompt('热量(kcal)：', '100');
        
        if (name && qty && kcal) {
            getDay(currentDate).foods.push({
                meal, name, qty: parseFloat(qty), unit,
                kcal: parseFloat(kcal), protein: 0, carb: 0, fat: 0, fiber: 0, sodium: 0
            });
            saveData();
            renderHome();
        }
    } else if (type === '2') {
        const name = prompt('运动名称：', '快走');
        const qty = prompt('距离/时长：', '3');
        const unit = prompt('单位(km/分钟)：', 'km');
        const kcal = prompt('消耗热量：', '150');
        
        if (name && qty && kcal) {
            getDay(currentDate).exercises.push({
                name, qty: parseFloat(qty), unit,
                kcal: parseFloat(kcal), met: 5
            });
            saveData();
            renderHome();
        }
    }
}

// 初始化
async function init() {
    // 加载本地数据
    const local = localStorage.getItem(LS_KEY);
    if (local) {
        data = JSON.parse(local);
    }
    
    // 加载云端数据并合并
    const cloud = await loadFromCloud();
    if (cloud && cloud.days) {
        for (let d in cloud.days) {
            if (!data.days[d]) data.days[d] = {};
            const cDay = cloud.days[d];
            if (cDay.foods) data.days[d].foods = cDay.foods;
            if (cDay.exercises) data.days[d].exercises = cDay.exercises;
            if (cDay.water !== undefined) data.days[d].water = cDay.water;
        }
        if (cloud.profile) data.profile = cloud.profile;
        localStorage.setItem(LS_KEY, JSON.stringify(data));
        console.log('[v0.1.0-1956] ☁️ 云端数据已合并');
    }
    
    renderHome();
}

// 启动
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
