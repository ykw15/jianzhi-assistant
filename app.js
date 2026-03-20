// ===== CSP-compatible Event Delegation =====
(function() {
    function parseArgs(argsStr) {
        if(!argsStr || !argsStr.trim()) return [];
        var args = [];
        var inQuote = false, quoteChar = '', current = '';
        for(var i = 0; i < argsStr.length; i++) {
            var c = argsStr[i];
            if((c === '"' || c === "'") && (i === 0 || argsStr[i-1] !== '\\')) {
                if(inQuote && c === quoteChar) { inQuote = false; }
                else if(!inQuote) { inQuote = true; quoteChar = c; }
                current += c;
            } else if(c === ',' && !inQuote) {
                args.push(current.trim());
                current = '';
            } else {
                current += c;
            }
        }
        if(current.trim()) args.push(current.trim());
        return args.map(function(a) {
            if(a === '') return undefined;
            if(a === 'true') return true;
            if(a === 'false') return false;
            if(a === 'null') return null;
            if(a.startsWith('"') && a.endsWith('"')) return a.slice(1,-1);
            if(a.startsWith("'") && a.endsWith("'")) return a.slice(1,-1);
            var num = Number(a);
            if(!isNaN(num)) return num;
            return a;
        });
    }

    function executeAction(action, el) {
        if(!action) return;
        var match = action.match(/^(\w+)\((.*)\)$/);
        if(match) {
            var fn = window[match[1]];
            if(typeof fn === 'function') {
                var args = parseArgs(match[2]);
                // Replace 'this' or 'event' keyword with the actual clicked element
                for(var i = 0; i < args.length; i++) {
                    if(args[i] === 'this' || args[i] === 'event') args[i] = el;
                }
                fn.apply(null, args);
            } else {
                console.warn('[delegation] unknown function:', match[1]);
            }
        } else {
            console.warn('[delegation] cannot parse action:', action);
        }
    }

    document.addEventListener('click', function(e) {
        var el = e.target.closest('[data-onclick]');
        if(el) { executeAction(el.dataset.onclick, el); }
    });
    document.addEventListener('input', function(e) {
        var el = e.target.closest('[data-oninput]');
        if(el) { executeAction(el.dataset.oninput); }
    });
    document.addEventListener('change', function(e) {
        var el = e.target.closest('[data-onchange]');
        if(el) { executeAction(el.dataset.onchange); }
    });
})();
// ===== Data Layer =====
var LS_KEY = 'health_tracker_v1';
var currentDate = null;
var data = null;
var _syncTimer = null;
var _syncing = false;
var _lastSyncTime = 0;
var _syncEnabled = false; // disabled during init, enabled after first sync

// ===== Cloud Sync (S3Plus AWS2) =====
var SYNC_CFG = {
    accessKey: 'SRV_TWf8pAm28iVVnYAjazSLqn4L8CkKyhZB',
    secretKey: 'Zj97qdzjCMXy8wnJ372n1z1aY7AkKsvM',
    host: 's3plus-bj02.vip.sankuai.com',
    bucket: 'openclaw-bucket',
    objectKey: 'health-dashboard/health-data.json'
};

// HMAC-SHA1 via SubtleCrypto (no external lib)
async function hmacSha1(key, message) {
    var enc = new TextEncoder();
    var cryptoKey = await crypto.subtle.importKey('raw', enc.encode(key), {name:'HMAC', hash:'SHA-1'}, false, ['sign']);
    var sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
    return btoa(String.fromCharCode.apply(null, new Uint8Array(sig)));
}

// 返回 {auth}（不含Content-MD5，浏览器SubtleCrypto不支持MD5）
async function s3Sign(method, contentType, dateStr, body) {
    // StringToSign: METHOD\n\nContent-Type\n\nx-amz-date:dateStr\n/bucket/key
    var stringToSign = method + "\n\n" + contentType + "\n\nx-amz-date:" + dateStr + "\n/" + SYNC_CFG.bucket + "/" + SYNC_CFG.objectKey;
    var signature = await hmacSha1(SYNC_CFG.secretKey, stringToSign);
    return { auth: 'AWS ' + SYNC_CFG.accessKey + ':' + signature };
}

function s3Url() {
    return 'https://' + SYNC_CFG.host + '/' + SYNC_CFG.bucket + '/' + SYNC_CFG.objectKey;
}

// Upload data to cloud
async function cloudPut(obj) {
    try {
        var body = JSON.stringify(obj);
        var dateStr = new Date().toUTCString();
        var ct = 'application/json';
        var signed = await s3Sign('PUT', ct, dateStr, body);
        var resp = await fetch(s3Url(), {
            method: 'PUT',
            headers: { 'Authorization': signed.auth, 'x-amz-date': dateStr, 'Content-Type': ct },
            body: body
        });
        if (!resp.ok) {
            console.warn('[sync] PUT status:', resp.status, await resp.text());
        }
        return resp.ok;
    } catch(e) {
        console.warn('[sync] PUT failed:', e);
        return false;
    }
}

// Download data from cloud (public read, no auth needed)
async function cloudGet() {
    try {
        var resp = await fetch(s3Url() + '?t=' + Date.now());
        if (!resp.ok) return null;
        return await resp.json();
    } catch(e) {
        console.warn('[sync] GET failed:', e);
        return null;
    }
}

// Merge: 云端优先策略
// 云端是权威数据源（可能被后端/agent更新），本地只在没有云端时才用
function mergeData(local, cloud) {
    if (!cloud) return local;
    if (!local || !local.profile) return cloud;
    
    // 云端优先：直接用云端数据，再补充本地独有的天数
    var merged = { profile: cloud.profile || local.profile || {}, days: {} };
    
    // 先复制所有云端天数
    if (cloud.days) {
        for (var dt in cloud.days) {
            merged.days[dt] = cloud.days[dt];
        }
    }
    
    // 再补充本地独有的天数（云端没有的）
    if (local.days) {
        for (var dt in local.days) {
            if (!merged.days[dt]) {
                merged.days[dt] = local.days[dt];
            }
        }
    }
    
    return merged;
}

// Sync indicator
function setSyncStatus(status) {
    var el = document.getElementById('sync-status');
    if (!el) return;
    var map = {
        'syncing': '☁️ 同步中...',
        'ok': '☁️ 已同步',
        'error': '⚠️ 同步失败',
        'offline': '📴 离线模式'
    };
    el.textContent = map[status] || status;
    el.className = 'sync-badge sync-' + status;
}

// Full sync: download → merge → save both
async function cloudSync(forceCloud) {
    if (_syncing) return;
    _syncing = true;
    setSyncStatus('ok'); // 内网不可用，直接成功
    
    try {
        var cloud = await cloudGet();
        var local = loadData();
        
        if (cloud) {
            // forceCloud=true: 直接用云端数据，不merge（用于强制刷新）
            var merged = forceCloud ? cloud : mergeData(local, cloud);
            data = merged;
            localStorage.setItem(LS_KEY, JSON.stringify(data));
        }
        
        // Upload merged (or local if no cloud)
        var ok = await cloudPut(data);
        setSyncStatus(ok ? 'ok' : 'error');
        _lastSyncTime = Date.now();
        
        // Refresh UI with synced data
        loadProfile();
        calcMetrics();
        updateAll();
        renderWater();

        if (forceCloud) {
            alert('✅ 已从云端强制刷新数据！');
        }
    } catch(e) {
        console.warn('[sync] error:', e);
        setSyncStatus('error');
    }
    
    _syncing = false;
}

// Force refresh from cloud
function toggleCalorieDetail() {
    var box = document.getElementById('calorie-detail-box');
    var btn = document.getElementById('calorie-detail-toggle');
    if (box.style.display === 'none') {
        box.style.display = 'block';
        btn.textContent = '▲ 收起计算逻辑';
    } else {
        box.style.display = 'none';
        btn.textContent = '▼ 展开计算逻辑';
    }
}

async function forceCloudRefresh() {
    if (confirm('强制从云端拉取数据，将覆盖本地缓存，确认吗？')) {
        await cloudSync(true);
    }
}

// Manual sync button
function manualSync() {
    cloudSync();
}

// Debounced sync after save (3s delay to batch rapid changes)
function scheduleSyncAfterSave() {
    if (!_syncEnabled) return; // skip during init
    if (_syncTimer) clearTimeout(_syncTimer);
    _syncTimer = setTimeout(function() {
        cloudSync();
    }, 3000);
}

function todayStr() { 
    const d = new Date(); 
    return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); 
}
function loadData() {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : { profile: {}, days: {} };
}
function saveData() {
    // Stamp current day with modification timestamp
    var day = data.days[currentDate];
    if (day) day._ts = Date.now();
    
    localStorage.setItem(LS_KEY, JSON.stringify(data));
    
    // v3.3.7: 直接调用云端保存
    if (typeof window._saveToCloud === 'function') {
        window._saveToCloud(data);
    }
    
    scheduleSyncAfterSave();
}
function getDay(d) { if(!data.days[d]) data.days[d]={exercises:[],foods:[],water:0,weight:null}; return data.days[d]; }

// 去除食物来源emoji前缀
function stripSrc(name) { return (name||'').replace(/^🛒\s*/, '').replace(/^🐘\s*/, '').replace(/^🛵\s*/, ''); }

// ===== Food Calorie & Nutrition DB =====
// per 100g: [kcal, protein(g), carb(g), fat(g), fiber(g)]
var FOOD_NDB = {
    '米饭':[116,2.6,25.9,0.3,0.3],'白米饭':[116,2.6,25.9,0.3,0.3],'面条':[110,3.5,21,0.6,0.8],'馒头':[221,7,44,1.1,1],'包子':[200,7,30,5,0.8],'饺子':[220,9,25,9,1],'面包':[260,8,49,3.5,2],'全麦面包':[247,13,41,3.4,7],
    '燕麦':[367,13.5,66,6.5,10],'燕麦片':[367,13.5,66,6.5,10],'糙米':[362,7.5,76,2.7,3.5],'紫薯':[82,1.6,18,0.2,2.2],'玉米':[112,4,19,2.3,2.7],'红薯':[90,1.6,21,0.1,3],'土豆':[81,2,17,0.1,2.2],
    '鸡胸肉':[133,31,0,1.2,0],'鸡腿':[181,20,0,11,0],'鸡翅':[223,17,0,17,0],'鸡蛋':[144,13,1.1,10,0],'牛肉':[125,20,0,5,0],'猪肉':[143,20,0,7,0],'五花肉':[395,14,0,37,0],'瘦肉':[143,20,0,7,0],
    '鱼':[104,18,0,3.2,0],'虾':[87,18,0,1,0],'三文鱼':[208,20,0,13,0],'带鱼':[127,18,0,5.5,0],'豆腐':[73,8,1.7,3.5,0.4],'豆浆':[16,1.8,1.1,0.7,0.1],'牛奶':[66,3.2,4.8,3.6,0],'酸奶':[72,3.5,7.5,2.7,0],
    '苹果':[52,0.3,14,0.2,2.4],'香蕉':[89,1.1,23,0.3,2.6],'橙子':[47,0.9,12,0.1,2.4],'葡萄':[69,0.7,18,0.2,0.9],'西瓜':[30,0.6,8,0.2,0.4],'草莓':[32,0.7,8,0.3,2],'猕猴桃':[61,1.1,15,0.5,3],'柚子':[38,0.8,10,0.1,1.6],
    '西兰花':[34,2.8,7,0.4,2.6],'菠菜':[23,2.9,3.6,0.4,2.2],'黄瓜':[15,0.7,3.6,0.1,0.5],'番茄':[18,0.9,3.9,0.2,1.2],'白菜':[13,1.5,2.2,0.2,1],'生菜':[15,1.4,2.9,0.2,1.3],'胡萝卜':[41,0.9,10,0.2,2.8],'芹菜':[16,0.7,3,0.2,1.6],
    '奶茶':[400,1.5,55,18,0],'可乐':[43,0,11,0,0],'啤酒':[43,0.5,3.6,0,0],'咖啡':[2,0.1,0,0,0],'美式咖啡':[2,0.1,0,0,0],'拿铁':[150,5,12,6,0],
    '蛋糕':[348,5,52,14,0.5],'饼干':[433,6,70,15,1],'薯片':[536,7,50,35,4],'巧克力':[546,5,60,31,3],'冰淇淋':[207,3.5,24,11,0.5],'香干马头菜':[120,10.1,3.2,7.4,0],'香干':[120,10.1,3.2,7.4,0],'马头菜':[30,1.5,5,0.5,2],
    '沙拉':[50,2,6,2,2],'轻食沙拉':[150,12,10,7,3],'鸡胸肉沙拉':[200,22,8,8,2],
    '盒饭':[600,20,75,22,3],'外卖':[700,22,80,28,2],'便当':[550,18,70,20,2],'炒饭':[180,6,25,6,1],'炒面':[160,5.5,22,5.5,1],'盖浇饭':[550,18,70,18,2],
    '火锅':[400,25,20,25,3],'烤肉':[300,25,5,20,0],'串串':[250,15,15,14,1],'麻辣烫':[350,12,35,16,3],'酸辣粉':[450,8,65,16,2],
    '三明治':[250,12,26,10,2],'汉堡':[295,17,24,15,1],'薯条':[312,3.4,41,15,3.8],'披萨':[266,11,33,10,2],
};
// Compat: simple kcal lookup
var FOOD_DB = {};
for(const [k,v] of Object.entries(FOOD_NDB)) FOOD_DB[k] = v[0];

function getNutrition(name, amount) {
    // Returns {kcal, protein, carb, fat, fiber}
    let nd = null;
    for(const [food, vals] of Object.entries(FOOD_NDB)) {
        if(name.includes(food)) { nd = vals; break; }
    }
    if(!nd) return { kcal:200, protein:8, carb:25, fat:7, fiber:2 }; // default per serving
    const base = { kcal:nd[0], protein:nd[1], carb:nd[2], fat:nd[3], fiber:nd[4] };
    let multiplier = 1; // default 100g
    if(amount) {
        const numMatch = amount.match(/(\d+\.?\d*)/);
        if(numMatch) {
            const num = parseFloat(numMatch[1]);
            if(amount.includes('g') || amount.includes('克')) multiplier = num / 100;
            else if(amount.includes('ml') || amount.includes('毫升')) multiplier = num / 100;
            else if(amount.includes('碗')) multiplier = num * 2;
            else if(amount.includes('杯')) multiplier = num * 2.5;
            else if(amount.includes('份') || amount.includes('盘')) multiplier = num * 2;
            else multiplier = num; // pieces
        }
    }
    return {
        kcal: Math.round(base.kcal * multiplier),
        protein: Math.round(base.protein * multiplier * 10) / 10,
        carb: Math.round(base.carb * multiplier * 10) / 10,
        fat: Math.round(base.fat * multiplier * 10) / 10,
        fiber: Math.round(base.fiber * multiplier * 10) / 10
    };
}

function estimateKcal(name, amount) {
    return getNutrition(name, amount).kcal;
}

// Ingredient temp list for current food being added
var tempIngredients = [];
var editTempIngredients = [];

function toggleIngredients() {
    const area = document.getElementById('fd-ingredients-area');
    const btn = document.getElementById('ig-toggle-btn');
    if(area.style.display === 'none') {
        area.style.display = 'block';
        btn.textContent = '🥬 收起食材明细';
    } else {
        area.style.display = 'none';
        btn.textContent = '🥬 展开食材明细';
    }
}

function toggleCalorieExplain() {
    const panel = document.getElementById('calorie-explain-panel');
    const btn = document.querySelector('.tooltip-trigger');
    if(panel.style.display === 'none') {
        panel.style.display = 'block';
        btn.textContent = '▲';
    } else {
        panel.style.display = 'none';
        btn.textContent = '▼';
    }
}

function parseIngredientText() {
    const text = document.getElementById('ig-text').value.trim();
    if(!text) return;
    tempIngredients = [];
    text.split('\n').forEach(function(line) {
        line = line.trim();
        if(!line) return;
        // 判断角色前缀
        let role = '主料';
        if(/^(辅|辅料)[：:\s]?/.test(line)) { role = '辅料'; line = line.replace(/^(辅|辅料)[：:\s]?/, '').trim(); }
        else if(/^(调|调料)[：:\s]?/.test(line)) { role = '调料'; line = line.replace(/^(调|调料)[：:\s]?/, '').trim(); }
        else if(/^(主|主料)[：:\s]?/.test(line)) { role = '主料'; line = line.replace(/^(主|主料)[：:\s]?/, '').trim(); }
        // 提取克重：支持 "鸡胸肉 150g" / "鸡胸肉150克" / "150g鸡胸肉" 等
        let name = line, weight = null;
        const m1 = line.match(/^(.+?)\s*(\d+\.?\d*)\s*(g|克|ml|毫升)$/i);
        const m2 = line.match(/^(\d+\.?\d*)\s*(g|克|ml|毫升)\s*(.+)$/i);
        const m3 = line.match(/^(.+?)\s+(\d+\.?\d*)$/); // "鸡胸肉 150"（无单位默认g）
        if(m1) { name = m1[1].trim(); weight = parseFloat(m1[2]); }
        else if(m2) { name = m2[3].trim(); weight = parseFloat(m2[1]); }
        else if(m3) { name = m3[1].trim(); weight = parseFloat(m3[2]); }
        if(!name) return;
        const nutr = getNutrition(name, weight ? weight+'g' : '');
        tempIngredients.push({ role, name, weight, ...nutr });
    });
    renderIngredientList();
}

function clearIngredients() {
    tempIngredients = [];
    document.getElementById('ig-text').value = '';
    renderIngredientList();
}

function delIngredient(i) {
    tempIngredients.splice(i, 1);
    renderIngredientList();
}

function renderIngredientList() {
    const div = document.getElementById('ig-list');
    if(tempIngredients.length === 0) { div.innerHTML = ''; return; }
    const total = calcIngredientsTotal();
    div.innerHTML = tempIngredients.map(function(ig, i) {
        return '<span class="ig-chip ' + ig.role + '">' + ig.role + ':' + ig.name + (ig.weight ? ' ' + ig.weight + 'g' : '') + ' ' + ig.kcal + 'kcal <span class="ig-del" data-onclick="delIngredient(' + i + ')">✕</span></span>';
    }).join('') + (total ? '<div style="margin-top:4px;font-size:11px;color:#555">合计：' + total.kcal + 'kcal | 蛋白' + total.protein + 'g | 碳水' + total.carb + 'g | 脂肪' + total.fat + 'g</div>' : '');
}

function calcIngredientsTotal() {
    if(tempIngredients.length === 0) return null;
    return {
        kcal: tempIngredients.reduce((s,ig) => s + ig.kcal, 0),
        protein: Math.round(tempIngredients.reduce((s,ig) => s + ig.protein, 0) * 10) / 10,
        carb: Math.round(tempIngredients.reduce((s,ig) => s + ig.carb, 0) * 10) / 10,
        fat: Math.round(tempIngredients.reduce((s,ig) => s + ig.fat, 0) * 10) / 10,
        fiber: Math.round(tempIngredients.reduce((s,ig) => s + ig.fiber, 0) * 10) / 10,
        ingredients: tempIngredients.map(ig => ({role:ig.role, name:ig.name, weight:ig.weight}))
    };
}

// ===== Edit Modal Ingredients =====
function toggleEditIngredients() {
    const area = document.getElementById('edit-fd-ingredients-area');
    const btn = document.getElementById('edit-ig-toggle-btn');
    if(area.style.display === 'none') {
        area.style.display = 'block';
        btn.textContent = '🥬 收起食材明细';
    } else {
        area.style.display = 'none';
        btn.textContent = '🥬 展开食材明细';
    }
}

function parseEditIngredients() {
    const text = document.getElementById('edit-ig-text').value.trim();
    if(!text) return;
    editTempIngredients = [];
    text.split('\n').forEach(function(line) {
        line = line.trim();
        if(!line) return;
        let role = '主料';
        if(/^(辅|辅料)[：:\s]?/.test(line)) { role = '辅料'; line = line.replace(/^(辅|辅料)[：:\s]?/, '').trim(); }
        else if(/^(调|调料)[：:\s]?/.test(line)) { role = '调料'; line = line.replace(/^(调|调料)[：:\s]?/, '').trim(); }
        else if(/^(主|主料)[：:\s]?/.test(line)) { role = '主料'; line = line.replace(/^(主|主料)[：:\s]?/, '').trim(); }
        let name = line, weight = null;
        const m1 = line.match(/^(.+?)\s*(\d+\.?\d*)\s*(g|克|ml|毫升)$/i);
        const m2 = line.match(/^(\d+\.?\d*)\s*(g|克|ml|毫升)\s*(.+)$/i);
        const m3 = line.match(/^(.+?)\s+(\d+\.?\d*)$/);
        if(m1) { name = m1[1].trim(); weight = parseFloat(m1[2]); }
        else if(m2) { name = m2[3].trim(); weight = parseFloat(m2[1]); }
        else if(m3) { name = m3[1].trim(); weight = parseFloat(m3[2]); }
        if(!name) return;
        const nutr = getNutrition(name, weight ? weight+'g' : '');
        editTempIngredients.push({ role, name, weight, ...nutr });
    });
    renderEditIngredientList();
}

function clearEditIngredients() {
    editTempIngredients = [];
    document.getElementById('edit-ig-text').value = '';
    renderEditIngredientList();
}

function delEditIngredient(i) {
    editTempIngredients.splice(i, 1);
    renderEditIngredientList();
}

function calcEditIngredientsTotal() {
    if(editTempIngredients.length === 0) return null;
    return {
        kcal: editTempIngredients.reduce((s,ig) => s + ig.kcal, 0),
        protein: Math.round(editTempIngredients.reduce((s,ig) => s + ig.protein, 0) * 10) / 10,
        carb: Math.round(editTempIngredients.reduce((s,ig) => s + ig.carb, 0) * 10) / 10,
        fat: Math.round(editTempIngredients.reduce((s,ig) => s + ig.fat, 0) * 10) / 10,
        fiber: Math.round(editTempIngredients.reduce((s,ig) => s + ig.fiber, 0) * 10) / 10,
        ingredients: editTempIngredients.map(ig => ({role:ig.role, name:ig.name, weight:ig.weight}))
    };
}

function renderEditIngredientList() {
    const div = document.getElementById('edit-ig-list');
    if(editTempIngredients.length === 0) { div.innerHTML = ''; return; }
    const total = calcEditIngredientsTotal();
    div.innerHTML = editTempIngredients.map(function(ig, i) {
        return '<span class="ig-chip ' + ig.role + '">' + ig.role + ':' + ig.name + (ig.weight ? ' ' + ig.weight + 'g' : '') + ' ' + ig.kcal + 'kcal <span class="ig-del" data-onclick="delEditIngredient(' + i + ')">✕</span></span>';
    }).join('') + (total ? '<div style="margin-top:4px;font-size:11px;color:#555">合计：' + total.kcal + 'kcal | 蛋白' + total.protein + 'g | 碳水' + total.carb + 'g | 脂肪' + total.fat + 'g</div>' : '');
}

function renderNutritionPanel() {
    const foods = getDay(currentDate).foods;
    const totals = { protein:0, carb:0, fat:0, fiber:0, kcal:0, sodium:0 };
    foods.forEach(f => {
        totals.protein += f.protein || 0;
        totals.carb += f.carb || 0;
        totals.fat += f.fat || 0;
        totals.fiber += f.fiber || 0;
        totals.kcal += f.kcal || 0;
        totals.sodium += f.sodium || 0;
    });
    const w = getWeight();
    const targets = { protein: Math.round(w * 1.6), carb: Math.round(w * 3), fat: Math.round(w * 0.8), fiber: 25, sodium: 2000 }; // 钠建议 ≤2000mg/天（WHO标准）
    
    function bar(label, cur, tgt, unit) {
        const pct = Math.min(150, Math.round(cur / tgt * 100));
        const cls = pct < 60 ? 'nutr-low' : pct > 120 ? 'nutr-over' : 'nutr-ok';
        return '<div class="metric-card"><div class="mv" style="font-size:14px">' + Math.round(cur) + unit + ' <span style="font-size:11px;color:#888">/ ' + tgt + unit + '</span></div><div class="ml">' + label + '</div><div class="nutr-bar"><div class="nutr-bar-fill ' + cls + '" style="width:' + Math.min(100, pct) + '%"></div></div></div>';
    }
    
    document.getElementById('nutrition-metrics').innerHTML =
        bar('蛋白质', totals.protein, targets.protein, 'g') +
        bar('碳水化合物', totals.carb, targets.carb, 'g') +
        bar('脂肪', totals.fat, targets.fat, 'g') +
        bar('膳食纤维', totals.fiber, targets.fiber, 'g') +
        bar('钠', totals.sodium, targets.sodium, 'mg');
    
    // Alerts
    const alerts = [];
    // 精准定位：找出各营养素贡献最高的食物
    function topFoods(arr, key, n) {
        return arr.filter(f => (f[key]||0) > 0)
            .sort((a,b) => (b[key]||0) - (a[key]||0))
            .slice(0, n || 3)
            .map(f => f.name.replace(/^🛒/,'') + '(' + Math.round(f[key]) + 'g)');
    }
    
    if(totals.protein < targets.protein * 0.6 && foods.length > 0) {
        const deficit = targets.protein - Math.round(totals.protein);
        alerts.push('⚠️ 蛋白质偏低（' + Math.round(totals.protein) + 'g / 建议' + targets.protein + 'g），还差 ' + deficit + 'g。建议加：鸡胸肉100g(+31g) / 鸡蛋2个(+13g) / 虾150g(+27g)');
    }
    if(totals.fat > targets.fat * 1.3 && foods.length > 0) {
        const topFat = topFoods(foods, 'fat', 3);
        alerts.push('⚠️ 脂肪偏高（' + Math.round(totals.fat) + 'g / 建议' + targets.fat + 'g）。主要来源：<strong>' + topFat.join('、') + '</strong>');
    }
    if(totals.carb > targets.carb * 1.3 && foods.length > 0) {
        const topCarb = topFoods(foods, 'carb', 3);
        alerts.push('⚠️ 碳水偏高（' + Math.round(totals.carb) + 'g / 建议' + targets.carb + 'g）。主要来源：<strong>' + topCarb.join('、') + '</strong>');
    }
    if(totals.fiber < 15 && foods.length >= 3) alerts.push('💡 膳食纤维偏低（' + Math.round(totals.fiber) + 'g / 建议25g），建议多吃蔬菜水果和全谷物');
    if(totals.sodium > 2000 && foods.length > 0) {
        const topSodium = topFoods(foods, 'sodium', 3).map(s => s.replace(/g\)$/,'mg)'));
        alerts.push('⚠️ 钠偏高（' + Math.round(totals.sodium) + 'mg / 建议≤2000mg）。主要来源：<strong>' + topSodium.join('、') + '</strong>');
    }
    if(foods.length > 0 && totals.protein >= targets.protein * 0.9 && totals.fat <= targets.fat * 1.1 && totals.carb <= targets.carb * 1.2) {
        alerts.push('✅ 营养摄入均衡，继续保持！');
    }
    
    // 单品预警：某个食物的脂肪或碳水特别高
    foods.forEach(function(f) {
        if((f.fat||0) > 20) alerts.push('🔍 <strong>' + f.name.replace(/^🛒/,'') + '</strong> 脂肪含量较高（' + Math.round(f.fat) + 'g），下次可考虑替换为低脂选择');
        if((f.kcal||0) > 600) alerts.push('🔍 <strong>' + f.name.replace(/^🛒/,'') + '</strong> 单品热量较高（' + f.kcal + 'kcal），注意控制份量');
    });
    
    document.getElementById('nutrition-alert').innerHTML = alerts.map(a => '<div class="alert-box ' + (a.startsWith('✅') ? 'alert-ok' : 'alert-warn') + '" style="margin-bottom:4px;font-size:12px">' + a + '</div>').join('');
}

// ===== Profile =====
function saveProfile() {
    const p = data.profile;
    p.name = document.getElementById('p-name').value || '用户';
    p.gender = document.getElementById('p-gender').value;
    p.birth = document.getElementById('p-birth').value;
    p.height = parseFloat(document.getElementById('p-height').value) || 0;
    p.weight0 = parseFloat(document.getElementById('p-weight0').value) || 0;
    p.activity = parseFloat(document.getElementById('p-activity').value);
    p._ts = Date.now();
    
    const w = parseFloat(document.getElementById('p-weight').value);
    if (w) { getDay(currentDate).weight = w; }
    
    const bf = parseFloat(document.getElementById('p-bodyfat').value);
    if (bf) { getDay(currentDate).bodyFat = bf; }
    
    saveData(); calcMetrics(); updateAll();
    alert('✅ 已保存！');
}

function loadProfile() {
    const p = data.profile;
    if(p.name) document.getElementById('p-name').value = p.name;
    if(p.gender) document.getElementById('p-gender').value = p.gender;
    if(p.birth) document.getElementById('p-birth').value = p.birth;
    if(p.height) document.getElementById('p-height').value = p.height;
    if(p.weight0) document.getElementById('p-weight0').value = p.weight0;
    if(p.activity) document.getElementById('p-activity').value = p.activity;
    const dw = getDay(currentDate).weight;
    if(dw) document.getElementById('p-weight').value = dw;
}

function getWeight() {
    const dw = getDay(currentDate).weight;
    return dw || data.profile.weight0 || 70;
}
function getAge() {
    if(!data.profile.birth) return 30;
    const b = new Date(data.profile.birth);
    const now = new Date();
    return now.getFullYear() - b.getFullYear() - (now < new Date(now.getFullYear(), b.getMonth(), b.getDate()) ? 1 : 0);
}

function calcMetrics() {
    const p = data.profile;
    if(!p.height) return;
    const w = getWeight(), h = p.height, age = getAge(), male = p.gender === 'male';
    
    const bmi = w / ((h/100) ** 2);
    const bmr = male ? (10*w + 6.25*h - 5*age + 5) : (10*w + 6.25*h - 5*age - 161);
    const tdee = bmr * (p.activity || 1.375);
    const bf = (1.2 * bmi + 0.23 * age - (male ? 16.2 : 5.4)).toFixed(1);
    const hrmax = 220 - age;
    const target = Math.round(tdee - 500);
    const goalW = male ? (h - 105) : (h - 110);
    
    document.getElementById('m-age').textContent = age;
    document.getElementById('m-bmi').textContent = bmi.toFixed(1);
    document.getElementById('m-bf').textContent = bf + '%';
    document.getElementById('m-bmr').textContent = Math.round(bmr);
    document.getElementById('m-tdee').textContent = Math.round(tdee);
    document.getElementById('m-target').textContent = target;
    document.getElementById('m-hrmax').textContent = hrmax;
    document.getElementById('m-hrfat').textContent = Math.round(hrmax*0.6) + '-' + Math.round(hrmax*0.7);
    document.getElementById('m-hraero').textContent = Math.round(hrmax*0.7) + '-' + Math.round(hrmax*0.8);
    document.getElementById('m-water').textContent = Math.round(w * 37);
    document.getElementById('m-protein').textContent = Math.round(w * 1.6);
    document.getElementById('m-goalw').textContent = goalW;
    document.getElementById('p-bf').value = bf;
    
    // Personal tips
    const tips = [];
    if(bmi > 28) tips.push('⚠️ BMI ' + bmi.toFixed(1) + ' 属于肥胖，建议先以饮食控制为主，运动从低强度开始');
    else if(bmi > 24) tips.push('📊 BMI ' + bmi.toFixed(1) + ' 属于超重，减脂计划非常及时！');
    if(bf > 25 && male) tips.push('体脂率偏高，重点增加有氧+控制碳水');
    if(bf > 30 && !male) tips.push('体脂率偏高，建议增加有氧运动频率');
    tips.push('🎯 你的燃脂心率区间：' + Math.round(hrmax*0.6) + '-' + Math.round(hrmax*0.7) + ' bpm，运动时保持在此区间效率最高');
    tips.push('💧 每天至少喝 ' + Math.round(w*37) + 'ml 水（约 ' + Math.round(w*37/250) + ' 杯）');
    tips.push('🥩 每天蛋白质目标 ' + Math.round(w*1.6) + 'g（约 ' + Math.round(w*1.6/30) + ' 个鸡蛋或 ' + Math.round(w*1.6/31*100) + 'g 鸡胸肉的蛋白质量）');
    tips.push('🏋️ 标准体重参考 ' + goalW + 'kg，当前差 ' + (w - goalW).toFixed(1) + 'kg');
    document.getElementById('personal-tips').innerHTML = '<strong>🎯 你的个性化建议：</strong><br>' + tips.join('<br>');
    
    return { tdee: Math.round(tdee), target, bmr: Math.round(bmr) };
}

// ===== Modal Helpers =====
function closeModal(id) { document.getElementById(id).classList.remove('show'); }

// ===== Exercise =====
// 不同单位转换为分钟的映射（用于消耗估算）
var UNIT_TO_MIN = {
    '分钟': function(qty) { return qty; },
    '公里': function(qty, met) { return met >= 7 ? qty * 6 : qty * 12; }, // 跑步≈6min/km，走路≈12min/km
    '组': function(qty) { return qty * 3; }, // 1组≈3分钟
    '个': function(qty) { return qty * 0.15; }, // 1个≈0.15分钟（如俯卧撑）
    '次': function(qty) { return qty * 0.15; },
    '米': function(qty, met) { return qty / (met >= 7 ? 167 : 83); }, // 跑步≈167m/min，走路≈83m/min
};

function addExercise() {
    const sel = document.getElementById('ex-type').value.split('|');
    const name = sel[0], met = parseFloat(sel[1]);
    const qty = parseFloat(document.getElementById('ex-qty').value) || 30;
    const unitSel = document.getElementById('ex-unit').value;
    const unitCustom = document.getElementById('ex-unit-custom').value.trim();
    const unit = unitCustom || unitSel;
    
    let kcal = parseInt(document.getElementById('ex-kcal').value);
    if(!kcal) {
        // 估算：先转换为分钟，再用MET计算
        const converter = UNIT_TO_MIN[unit];
        const mins = converter ? converter(qty, met) : qty; // 未知单位默认当分钟
        kcal = Math.round(met * getWeight() * (mins / 60));
    }
    
    getDay(currentDate).exercises.push({ name, qty, unit, kcal, min: null }); // min保留兼容
    saveData(); renderExercise(); updateAll();
    document.getElementById('ex-qty').value = '';
    document.getElementById('ex-kcal').value = '';
    document.getElementById('ex-unit-custom').value = '';
}

function delExercise(i) { getDay(currentDate).exercises.splice(i,1); saveData(); renderExercise(); updateAll(); }

function editExercise(i) {
    const e = getDay(currentDate).exercises[i];
    document.getElementById('edit-ex-idx').value = i;
    document.getElementById('edit-ex-name').value = e.name;
    document.getElementById('edit-ex-qty').value = e.qty || e.min || '';
    // 设置单位
    const stdUnits = ['分钟','公里','组','个','次','米'];
    const u = e.unit || '分钟';
    if(stdUnits.includes(u)) {
        document.getElementById('edit-ex-unit').value = u;
        document.getElementById('edit-ex-unit-custom').value = '';
    } else {
        document.getElementById('edit-ex-unit').value = '分钟';
        document.getElementById('edit-ex-unit-custom').value = u;
    }
    document.getElementById('edit-ex-kcal').value = e.kcal;
    document.getElementById('modal-edit-ex').classList.add('show');
}

function saveEditExercise() {
    const i = parseInt(document.getElementById('edit-ex-idx').value);
    const e = getDay(currentDate).exercises[i];
    e.name = document.getElementById('edit-ex-name').value.trim() || e.name;
    e.qty = parseFloat(document.getElementById('edit-ex-qty').value) || e.qty || e.min;
    const unitCustom = document.getElementById('edit-ex-unit-custom').value.trim();
    e.unit = unitCustom || document.getElementById('edit-ex-unit').value;
    e.kcal = parseInt(document.getElementById('edit-ex-kcal').value) || e.kcal;
    saveData(); renderExercise(); updateAll();
    closeModal('modal-edit-ex');
}

function renderExercise() {
    const exs = getDay(currentDate).exercises;
    const body = document.getElementById('ex-body');
    body.innerHTML = exs.map((e,i) => {
        const qtyDisplay = (e.qty || e.min || '?') + ' ' + (e.unit || '分钟');
        return `<tr><td>${e.name}</td><td>${qtyDisplay}</td><td>${e.kcal}</td><td class="action-cell"><button class="edit-btn" data-onclick="editExercise(${i})">✏️</button><span class="del-btn" data-onclick="delExercise(${i})">✕</span></td></tr>`;
    }).join('') || '<tr><td colspan="4" style="text-align:center;color:#999">今天还没运动哦，动起来！</td></tr>';
    const total = Math.round(exs.reduce((s,e) => s + e.kcal, 0));
    document.getElementById('ex-total').textContent = total + ' kcal';
}

// ===== Food =====
// 千焦转千卡：1 kcal = 4.184 kJ
function kjToKcal(kj) { return Math.round(kj / 4.184); }
function kcalToKj(kcal) { return Math.round(kcal * 4.184); }

// ===== Food History (记忆功能) =====
function getFoodHistory() {
    // 从所有历史记录中提取食物，去重，保留最新的
    const history = {};
    Object.keys(data.days).sort().forEach(function(date) {
        (data.days[date].foods || []).forEach(function(f) {
            // 用食物名做key，后面的会覆盖前面的（保留最新）
            const key = f.name.replace(/^🛒/, '').trim();
            history[key] = {
                name: f.name,
                amount: f.amount,
                kcal: f.kcal,
                protein: f.protein,
                carb: f.carb,
                fat: f.fat,
                fiber: f.fiber,
                sodium: f.sodium,
                source: f.source,
                ingredients: f.ingredients
            };
        });
    });
    return history;
}

function updateFoodHistoryList() {
    const history = getFoodHistory();
    const datalist = document.getElementById('fd-history-datalist') || document.getElementById('fd-history');
    if (!datalist) return;
    datalist.innerHTML = Object.keys(history).map(function(name) {
        return '<option value="' + name + '">';
    }).join('');
}

function checkFoodHistory() {
    const name = document.getElementById('fd-name').value.trim();
    const history = getFoodHistory();
    const match = history[name] || history[name.replace(/^🛒/, '').trim()];
    if(match) {
        // 自动填入历史数据
        const srcMap = {'🛒':'hema','🐘':'xiaoxiang','🛵':'dingdong'};
        const srcChar = match.name.charAt(0);
        document.getElementById('fd-source').value = srcMap[srcChar] || match.source || '';
        const parsed = parseAmount(match.amount);
        document.getElementById('fd-qty').value = parsed.qty;
        const stdUnits = ['g','ml','个','份','碗','杯','盘','片','根','块','袋','盒'];
        if(stdUnits.includes(parsed.unit)) {
            document.getElementById('fd-amt-unit').value = parsed.unit;
        }
        if(match.kcal) document.getElementById('fd-kcal').value = match.kcal;
        // 如果有食材明细，显示提示
        if(match.ingredients && match.ingredients.length > 0) {
            document.getElementById('fd-ingredients-area').style.display = 'block';
            document.getElementById('ig-toggle-btn').textContent = '🥬 收起食材明细';
            tempIngredients = match.ingredients.map(function(ig) {
                const nutr = getNutrition(ig.name, ig.weight ? ig.weight+'g' : '');
                return { ...ig, ...nutr };
            });
            renderIngredientList();
            document.getElementById('ig-text').value = match.ingredients.map(function(ig) {
                return (ig.role !== '主料' ? ig.role + ' ' : '') + ig.name + (ig.weight ? ' ' + ig.weight + 'g' : '');
            }).join('\n');
        }
    }
}

function buildAmount() {
    const qty = document.getElementById('fd-qty').value.trim();
    const amtUnit = document.getElementById('fd-amt-unit').value;
    const amtCustom = document.getElementById('fd-amt-custom').value.trim();
    const u = amtCustom || amtUnit;
    if(!qty) return '1份';
    return qty + u;
}

function addFood() {
    const meal = document.getElementById('fd-meal').value;
    const name = document.getElementById('fd-name').value.trim();
    if(!name) { alert('请输入食物名称'); return; }
    const amount = buildAmount();
    
    let inputVal = parseFloat(document.getElementById('fd-kcal').value);
    const unit = document.getElementById('fd-unit').value;
    const inputMode = document.getElementById('fd-input-mode').value; // 'total' or 'per100'
    
    // 如果是 per100 模式，根据份量换算成总量
    const grams = extractGrams(amount);
    function convertFromPer100(val) {
        if(inputMode === 'per100' && grams && val) {
            return Math.round(val * grams / 100);
        }
        return val;
    }
    
    // Check if we have ingredients
    const igTotal = calcIngredientsTotal();
    let kcal, protein, carb, fat, fiber, ingredients;
    
    if(igTotal) {
        // 食材模式：食材数据是总量，不受 per100 影响
        kcal = inputVal ? convertFromPer100(unit === 'kj' ? kjToKcal(inputVal) : Math.round(inputVal)) : igTotal.kcal;
        protein = igTotal.protein;
        carb = igTotal.carb;
        fat = igTotal.fat;
        fiber = igTotal.fiber;
        ingredients = igTotal.ingredients;
    } else {
        const nutr = getNutrition(name, amount);
        kcal = inputVal ? convertFromPer100(unit === 'kj' ? kjToKcal(inputVal) : Math.round(inputVal)) : nutr.kcal;
        protein = nutr.protein;
        carb = nutr.carb;
        fat = nutr.fat;
        fiber = nutr.fiber;
        ingredients = null;
    }
    
    const source = document.getElementById('fd-source').value;
    const sourcePrefix = {'hema':'🛒','xiaoxiang':'🐘','dingdong':'🛵'}[source] || '';
    getDay(currentDate).foods.push({ meal, name: sourcePrefix ? sourcePrefix+name : name, amount, kcal, protein, carb, fat, fiber, ingredients, source: source });
    saveData(); renderFood(); renderNutritionPanel(); updateAll(); updateFoodHistoryList();
    document.getElementById('fd-name').value = '';
    document.getElementById('fd-qty').value = '';
    document.getElementById('fd-kcal').value = '';
    document.getElementById('fd-amt-custom').value = '';
    document.getElementById('fd-source').value = '';
    document.getElementById('fd-input-mode').value = 'total';
    tempIngredients = [];
    renderIngredientList();
    // 收起食材区
    document.getElementById('fd-ingredients-area').style.display = 'none';
    document.getElementById('ig-toggle-btn').textContent = '🥬 展开食材明细';
    document.getElementById('ig-text').value = '';
}

function delFood(i) { getDay(currentDate).foods.splice(i,1); saveData(); renderFood(); renderNutritionPanel(); updateAll(); }

function toggleEditPer100Hint() {
    const mode = document.getElementById('edit-fd-input-mode').value;
    document.getElementById('edit-fd-per100-hint').style.display = mode === 'per100' ? 'inline' : 'none';
}

function onEditInputModeChange() {
    var mode = document.getElementById('edit-fd-input-mode').value;
    var qty = parseFloat(document.getElementById('edit-fd-qty').value) || 0;
    var grams = qty;
    
    if (mode === 'per100') {
        // 切换到每100g
        var kcalEl = document.getElementById('edit-fd-kcal');
        var pEl = document.getElementById('edit-fd-protein');
        var cEl = document.getElementById('edit-fd-carb');
        var fEl = document.getElementById('edit-fd-fat');
        var fiEl = document.getElementById('edit-fd-fiber');
        var sEl = document.getElementById('edit-fd-sodium');
        
        // 有存 per100 数据直接用
        if (kcalEl.dataset.per100 !== undefined) {
            kcalEl.value = kcalEl.dataset.per100;
            pEl.value = pEl.dataset.per100 || '';
            cEl.value = cEl.dataset.per100 || '';
            fEl.value = fEl.dataset.per100 || '';
            fiEl.value = fiEl.dataset.per100 || '';
            sEl.value = sEl.dataset.per100 || '';
        } else if (grams > 0) {
            var kcal = parseFloat(kcalEl.value) || 0;
            var protein = parseFloat(pEl.value) || 0;
            var carb = parseFloat(cEl.value) || 0;
            var fat = parseFloat(fEl.value) || 0;
            var fiber = parseFloat(fiEl.value) || 0;
            var sodium = parseFloat(sEl.value) || 0;
            kcalEl.value = Math.round(kcal / grams * 100);
            pEl.value = Math.round(protein / grams * 100 * 10) / 10;
            cEl.value = Math.round(carb / grams * 100 * 10) / 10;
            fEl.value = Math.round(fat / grams * 100 * 10) / 10;
            fiEl.value = Math.round(fiber / grams * 100 * 10) / 10;
            sEl.value = Math.round(sodium / grams * 100);
            // store per100
            kcalEl.dataset.per100 = kcalEl.value;
            pEl.dataset.per100 = pEl.value;
            cEl.dataset.per100 = cEl.value;
            fEl.dataset.per100 = fEl.value;
            fiEl.dataset.per100 = fiEl.value;
            sEl.dataset.per100 = sEl.value;
        }
    } else {
        // 切回总量
        var kcalPer100 = parseFloat(document.getElementById('edit-fd-kcal').value) || 0;
        if (document.getElementById('edit-fd-kcal').dataset.per100 !== undefined && grams > 0) {
            var p = parseFloat(document.getElementById('edit-fd-protein').dataset.per100) || 0;
            var c = parseFloat(document.getElementById('edit-fd-carb').dataset.per100) || 0;
            var f = parseFloat(document.getElementById('edit-fd-fat').dataset.per100) || 0;
            var s = parseFloat(document.getElementById('edit-fd-sodium').dataset.per100) || 0;
            var fi = parseFloat(document.getElementById('edit-fd-fiber').dataset.per100) || 0;
            document.getElementById('edit-fd-kcal').value = Math.round(kcalPer100 * grams / 100);
            document.getElementById('edit-fd-protein').value = Math.round(p * grams / 100 * 10) / 10;
            document.getElementById('edit-fd-carb').value = Math.round(c * grams / 100 * 10) / 10;
            document.getElementById('edit-fd-fat').value = Math.round(f * grams / 100 * 10) / 10;
            document.getElementById('edit-fd-fiber').value = Math.round(fi * grams / 100 * 10) / 10;
            document.getElementById('edit-fd-sodium').value = Math.round(s * grams / 100);
        }
    }
    // 更新hint显示
    toggleEditPer100Hint();
}

function parseAmount(amountStr) {
    // Parse "100g" → {qty:100, unit:'g'} or "40g(1枚)" → {qty:40, unit:'g'}
    // or "2碗" → {qty:2, unit:'碗'}
    if(!amountStr) return { qty:'', unit:'份' };
    // 先尝试匹配带括号注释的格式: "40g(1枚)" "90g(原料)"
    const mNote = amountStr.match(/^(\d+\.?\d*)\s*(g|克|ml|毫升|碗|杯|个|份|片|根|块|袋|盒)\s*(\(.+\))?$/i);
    if(mNote) return { qty: mNote[1], unit: mNote[2] };
    // 通用匹配
    const m = amountStr.match(/^(\d+\.?\d*)\s*(.+)$/);
    if(m) return { qty: m[1], unit: m[2] };
    return { qty:'', unit:'份' };
}

function editFood(i) {
    const f = getDay(currentDate).foods[i];
    document.getElementById('edit-fd-idx').value = i;
    document.getElementById('edit-fd-meal').value = f.meal;
    document.getElementById('edit-fd-name').value = f.name;
    // Parse amount into qty + unit
    const parsed = parseAmount(f.amount);
    document.getElementById('edit-fd-qty').value = parsed.qty;
    const stdUnits = ['g','ml','个','份','碗','杯','盘','片','根','块','袋','盒'];
    if(stdUnits.includes(parsed.unit)) {
        document.getElementById('edit-fd-amt-unit').value = parsed.unit;
        document.getElementById('edit-fd-amt-custom').value = '';
    } else {
        document.getElementById('edit-fd-amt-unit').value = 'g';
        document.getElementById('edit-fd-amt-custom').value = parsed.unit;
    }
    document.getElementById('edit-fd-kcal').value = f.kcal;
    document.getElementById('edit-fd-unit').value = 'kcal';
    document.getElementById('edit-fd-protein').value = f.protein || '';
    document.getElementById('edit-fd-carb').value = f.carb || '';
    document.getElementById('edit-fd-fat').value = f.fat || '';
    document.getElementById('edit-fd-fiber').value = f.fiber || '';
    document.getElementById('edit-fd-sodium').value = f.sodium || '';
    document.getElementById('edit-fd-input-mode').value = 'total';
    document.getElementById('edit-fd-per100-hint').style.display = 'block';
    // 来源
    document.getElementById('edit-fd-source').value = f.source || (f.name.startsWith('🛒') ? 'hema' : '');
    
    // 计算并存储 per100 基准数据
    var grams = parsed.qty;
    _editPer100 = null;
    if(grams > 0 && f.kcal) {
        _editPer100 = {
            kcal: Math.round(f.kcal / grams * 100 * 10) / 10,
            protein: Math.round((f.protein||0) / grams * 100 * 10) / 10,
            carb: Math.round((f.carb||0) / grams * 100 * 10) / 10,
            fat: Math.round((f.fat||0) / grams * 100 * 10) / 10,
            sodium: Math.round((f.sodium||0) / grams * 100)
        };
        // 显示per100参考行
        var refEl = document.getElementById('edit-fd-per100-ref');
        if (refEl) {
            refEl.style.display = 'block';
            refEl.innerHTML = '📋 <b>每100g</b>：' + _editPer100.kcal + 'kcal | 蛋白 ' + _editPer100.protein + 'g | 碳水 ' + _editPer100.carb + 'g | 脂肪 ' + _editPer100.fat + 'g' + (_editPer100.sodium ? ' | 钠 ' + _editPer100.sodium + 'mg' : '');
        }
    }
    
    // 食材
    if(f.ingredients && f.ingredients.length > 0) {
        editTempIngredients = f.ingredients.map(function(ig) {
            const nutr = getNutrition(ig.name, ig.weight ? ig.weight+'g' : '');
            return { role: ig.role, name: ig.name, weight: ig.weight, ...nutr };
        });
        document.getElementById('edit-ig-text').value = f.ingredients.map(function(ig) {
            return (ig.role !== '主料' ? ig.role + ' ' : '') + ig.name + (ig.weight ? ' ' + ig.weight + 'g' : '');
        }).join('\n');
        renderEditIngredientList();
    } else {
        editTempIngredients = [];
        document.getElementById('edit-ig-text').value = '';
        document.getElementById('edit-ig-list').innerHTML = '';
    }
    document.getElementById('edit-fd-ingredients-area').style.display = 'none';
    document.getElementById('edit-ig-toggle-btn').textContent = '🥬 展开食材明细';
    document.getElementById('modal-edit-fd').classList.add('show');
}

function saveEditFood() {
    var i = parseInt(document.getElementById('edit-fd-idx').value);
    var f = getDay(currentDate).foods[i];
    if(!f) { closeModal('modal-edit-fd'); return; }
    var oldName = f.name;
    var oldAmount = f.amount;

    // 餐次
    f.meal = document.getElementById('edit-fd-meal').value;

    // 名称 + 来源
    var newName = document.getElementById('edit-fd-name').value.trim() || f.name;
    var source = document.getElementById('edit-fd-source').value;
    newName = stripSrc(newName);
    var prefixMap = {'hema':'🛒','xiaoxiang':'🐘','dingdong':'🛵'};
    var prefix = prefixMap[source] || '';
    f.name = prefix ? prefix + newName : newName;
    f.source = source;

    // 份量
    var editQty = document.getElementById('edit-fd-qty').value.trim();
    var editAmtUnit = document.getElementById('edit-fd-amt-custom').value.trim() || document.getElementById('edit-fd-amt-unit').value;
    f.amount = editQty ? (editQty + editAmtUnit) : f.amount;

    // per100 换算函数（先定义再使用）
    var editMode = document.getElementById('edit-fd-input-mode').value;
    var editGrams = extractGrams(f.amount);
    function cvt(val) {
        if(editMode === 'per100' && editGrams && val) return Math.round(val * editGrams / 100 * 10) / 10;
        return val;
    }

    // 热量（空值或删除 = 0）
    var kcalRaw = document.getElementById('edit-fd-kcal').value.trim();
    var inputVal = kcalRaw === '' ? 0 : parseFloat(kcalRaw);
    var unit = document.getElementById('edit-fd-unit').value;
    f.kcal = cvt(unit === 'kj' ? kjToKcal(inputVal || 0) : Math.round(inputVal || 0));

    // 营养（空值或删除 = 0）
    var ep = document.getElementById('edit-fd-protein').value.trim();
    var ec = document.getElementById('edit-fd-carb').value.trim();
    var ef = document.getElementById('edit-fd-fat').value.trim();
    var efi = document.getElementById('edit-fd-fiber').value.trim();
    var es = document.getElementById('edit-fd-sodium').value.trim();
    f.protein = cvt(ep === '' ? 0 : parseFloat(ep));
    f.carb = cvt(ec === '' ? 0 : parseFloat(ec));
    f.fat = cvt(ef === '' ? 0 : parseFloat(ef));
    f.fiber = cvt(efi === '' ? 0 : parseFloat(efi));
    f.sodium = cvt(es === '' ? 0 : parseFloat(es));

    // 名称/份量变了且没手动填营养 → 自动估算
    if((f.name !== oldName || f.amount !== oldAmount) && ep === '' && ec === '' && ef === '' && !f.ingredients) {
        var nutr = getNutrition(f.name, f.amount);
        f.protein = nutr.protein;
        f.carb = nutr.carb;
        f.fat = nutr.fat;
        f.fiber = nutr.fiber;
    }

    saveData(); renderFood(); renderNutritionPanel(); updateAll(); updateFoodHistoryList();
    closeModal('modal-edit-fd');
}

// 解析份量中的克数用于换算每100g
function extractGrams(amount) {
    if(!amount) return null;
    // 支持 "200g" "200g(1枚)" "90g(原料)" "200克" "250ml" 等格式
    const m = amount.match(/^(\d+\.?\d*)\s*(g|克|ml|毫升)/i);
    if(m) return parseFloat(m[1]);
    // 支持 "1个(50g)" "2个(100g)" — 从括号里提取克数
    const mParen = amount.match(/\((\d+\.?\d*)\s*(g|克|ml|毫升)\)/i);
    if(mParen) return parseFloat(mParen[1]);
    const mBowl = amount.match(/^(\d+\.?\d*)\s*碗/);
    if(mBowl) return parseFloat(mBowl[1]) * 200;
    const mCup = amount.match(/^(\d+\.?\d*)\s*杯/);
    if(mCup) return parseFloat(mCup[1]) * 250;
    return null; // 份、个、片等无法精确换算
}

function per100(val, grams) {
    if(!val || !grams || grams <= 0) return null;
    return Math.round(val / grams * 100);
}

function fmtPer100(val, grams, unit) {
    const p = per100(val, grams);
    if(p === null) return Math.round(val || 0) + unit;
    return '<span>' + Math.round(val) + unit + '</span><span style="color:#999;font-size:10px">/' + p + '</span>';
}

function renderFood() {
    const foods = getDay(currentDate).foods;
    // 排序：需要保留原索引
    const indexed = foods.map((f,i) => ({f, i}));
    const mealOrder = {'早餐':1,'午餐':2,'下午茶':3,'晚餐':4,'夜宵':5,'零食':6};
    if(currentFoodSort === 'meal') {
        indexed.sort((a,b) => (mealOrder[a.f.meal]||9) - (mealOrder[b.f.meal]||9));
    } else if(currentFoodSort === 'kcal') {
        indexed.sort((a,b) => (b.f.kcal||0) - (a.f.kcal||0));
    }
    // time 保持原序
    const body = document.getElementById('fd-body');
    body.innerHTML = indexed.map(({f,i}) => {
        const igBadge = f.ingredients ? ' <span style="font-size:10px;color:#1976d2" title="含食材明细">📋</span>' : '';
        const g = extractGrams(f.amount, f.qty, f.unit);
        const kcalCell = fmtPer100(f.kcal, g, 'kcal');
        const proteinCell = fmtPer100(f.protein, g, 'g');
        const carbCell = fmtPer100(f.carb, g, 'g');
        const fatCell = fmtPer100(f.fat, g, 'g');
        const sodiumCell = f.sodium ? fmtPer100(f.sodium, g, 'mg') : '-';
        const fiberCell = f.fiber ? fmtPer100(f.fiber, g, 'g') : '-';
        const amountDisplay = (f.qty != null ? f.qty : '') + (f.unit || '');
        return `<tr><td>${f.meal}</td><td>${f.name}${igBadge}</td><td>${amountDisplay}</td><td>${kcalCell}</td><td>${proteinCell}</td><td>${carbCell}</td><td>${fatCell}</td><td>${fiberCell}</td><td>${sodiumCell}</td><td class="action-cell"><button class="edit-btn" data-onclick="editFood(${i})">✏️</button><span class="del-btn" data-onclick="delFood(${i})">✕</span></td></tr>`;
    }).join('') || '<tr><td colspan="10" style="text-align:center;color:#999">还没记录饮食</td></tr>';
    const total = Math.round(foods.reduce((s,f) => s + f.kcal, 0));
    const proteinTotal = foods.reduce((s,f) => s + (f.protein||0), 0);
    const carbTotal = foods.reduce((s,f) => s + (f.carb||0), 0);
    const fatTotal = foods.reduce((s,f) => s + (f.fat||0), 0);
    const fiberTotal = foods.reduce((s,f) => s + (f.fiber||0), 0);
    const sodiumTotal = foods.reduce((s,f) => s + (f.sodium||0), 0);
    document.getElementById('fd-total').textContent = total + ' kcal';
    document.getElementById('fd-protein-total').textContent = Math.round(proteinTotal) + 'g';
    document.getElementById('fd-carb-total').textContent = Math.round(carbTotal) + 'g';
    document.getElementById('fd-fat-total').textContent = Math.round(fatTotal) + 'g';
    document.getElementById('fd-fiber-total').textContent = Math.round(fiberTotal*10)/10 + 'g';
    document.getElementById('fd-sodium-total').textContent = Math.round(sodiumTotal) + 'mg';
    renderNutritionPanel();
    renderMealPieCharts();
}

// ===== 餐次营养饼图 =====
var _mealPieCharts = {};
function renderMealPieCharts() {
    var foods = getDay(currentDate).foods || [];
    if (!foods.length) {
        var sec = document.getElementById('meal-pie-section');
        if (sec) sec.style.display = 'none';
        return;
    }
    var sec = document.getElementById('meal-pie-section');
    if (sec) sec.style.display = '';

    // 按餐次汇总
    var meals = {};
    var mealOrder = {'早餐':1,'午餐':2,'下午茶':3,'晚餐':4,'夜宵':5,'零食':6};
    for (var i = 0; i < foods.length; i++) {
        var f = foods[i];
        var m = f.meal || '其他';
        if (!meals[m]) meals[m] = {kcal:0, protein:0, carb:0, fat:0};
        meals[m].kcal += (f.kcal || 0);
        meals[m].protein += (f.protein || 0);
        meals[m].carb += (f.carb || 0);
        meals[m].fat += (f.fat || 0);
    }

    // 排序餐次
    var mealNames = Object.keys(meals).sort(function(a,b) {
        return (mealOrder[a]||9) - (mealOrder[b]||9);
    });

    var colors = ['#FF6384','#36A2EB','#FFCE56','#4BC0C0','#9966FF','#FF9F40'];

    function drawPie(canvasId, field, unit) {
        var canvas = document.getElementById(canvasId);
        if (!canvas || typeof Chart === 'undefined') return;
        if (_mealPieCharts[canvasId]) _mealPieCharts[canvasId].destroy();

        var values = mealNames.map(function(m) { return Math.round(meals[m][field]); });
        var total = values.reduce(function(s,v) { return s+v; }, 0);
        var labels = mealNames.map(function(m, i) {
            var pct = total > 0 ? Math.round(values[i] / total * 100) : 0;
            return m + ' ' + values[i] + unit + ' (' + pct + '%)';
        });

        _mealPieCharts[canvasId] = new Chart(canvas.getContext('2d'), {
            type: 'doughnut',
            data: {
                labels: labels,
                datasets: [{
                    data: values,
                    backgroundColor: colors.slice(0, mealNames.length),
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: { font: { size: 10 }, boxWidth: 12, padding: 6 }
                    },
                    tooltip: {
                        callbacks: {
                            label: function(ctx) {
                                var pct = total > 0 ? Math.round(ctx.raw / total * 100) : 0;
                                return ctx.label.split(' (')[0] + ': ' + ctx.raw + unit + ' (' + pct + '%)';
                            }
                        }
                    }
                }
            }
        });
    }

    drawPie('pie-kcal', 'kcal', 'kcal');
    drawPie('pie-protein', 'protein', 'g');
    drawPie('pie-carb', 'carb', 'g');
    drawPie('pie-fat', 'fat', 'g');
}

// ===== Calorie =====
function updateCalorie() {
    const m = calcMetrics();
    if(!m) return;
    const day = getDay(currentDate);
    const exBurn = day.exercises.reduce((s,e) => s + e.kcal, 0);
    const eaten = day.foods.reduce((s,f) => s + f.kcal, 0);
    
    // === 计算逻辑 ===
    // 基础消耗 = BMR × 1.2（久坐，不含运动）
    // 有效运动消耗 = 运动消耗 × 70%（折算系数，考虑估算误差）
    // 总消耗 = 基础消耗 + 有效运动消耗
    // 摄入上限 = 总消耗 - 500
    
    const exEffective = Math.round(exBurn * 0.7);
    const totalBurn = m.tdee + exEffective;
    const target = totalBurn - 500;
    const remain = parseFloat((target - eaten).toFixed(1));
    const deficit = parseFloat((totalBurn - eaten).toFixed(1));
    
    document.getElementById('c-tdee').textContent = m.tdee;
    document.getElementById('c-exercise').textContent = exBurn + (exBurn > 0 ? ' (×70%=' + exEffective + ')' : '');
    document.getElementById('c-total-burn').textContent = totalBurn;
    document.getElementById('c-eaten').textContent = eaten;
    document.getElementById('c-target').textContent = target;
    document.getElementById('c-remain').textContent = Math.max(0, remain).toFixed(1).replace('.0','');
    
    // Header
    document.getElementById('h-eaten').textContent = eaten;
    document.getElementById('h-burned').textContent = exEffective;
    document.getElementById('h-remain').textContent = Math.max(0, remain).toFixed(1).replace('.0','');
    document.getElementById('h-deficit').textContent = deficit.toFixed(1).replace('.0','');
    
    // Progress bar
    const pct = target > 0 ? Math.min(120, (eaten / target) * 100) : 0;
    const bar = document.getElementById('cal-bar');
    const barText = document.getElementById('cal-bar-text');
    bar.style.width = Math.min(100, pct) + '%';
    barText.textContent = Math.round(pct) + '%';
    bar.className = 'calorie-fill ' + (pct > 100 ? 'over' : pct > 85 ? 'warn' : 'ok');
    
    // Alert
    const alert = document.getElementById('cal-alert');
    if(pct > 100) {
        alert.className = 'alert-box alert-over';
        alert.innerHTML = '🚨 <strong>已超标！</strong>超出 ' + Math.abs(remain) + ' kcal。建议减少下一餐摄入。';
    } else if(deficit > 1000) {
        alert.className = 'alert-box alert-warn';
        alert.innerHTML = '⚠️ 缺口偏大（' + deficit + ' kcal），建议适当多吃，控制在 500-800。';
    } else if(pct > 85) {
        alert.className = 'alert-box alert-warn';
        alert.innerHTML = '⚠️ 接近上限了！还剩 ' + remain + ' kcal，注意控制。';
    } else {
        alert.className = 'alert-box alert-ok';
        alert.innerHTML = '✅ 状态良好！还能吃 ' + remain + ' kcal，缺口 ' + deficit + ' kcal，减脂节奏OK。';
    }
}

// ===== Log & Chart =====
var weightChart = null;
function renderLog() {
    const tbody = document.getElementById('log-body');
    const dates = Object.keys(data.days).sort().reverse();
    const waterTarget = getWaterTarget();
    const p = data.profile;
    const w = getWeight();
    // 计算 TDEE（用于每日缺口估算）
    const m = calcMetrics();
    const tdee = m ? m.tdee : 0;
    
    tbody.innerHTML = dates.map(d => {
        const day = data.days[d];
        const eaten = (day.foods||[]).reduce((s,f)=>s+f.kcal,0);
        // 有效运动消耗 = 运动 × 70%
        const rawBurned = (day.exercises||[]).reduce((s,e)=>s+e.kcal,0);
        const burned = Math.round(rawBurned * 0.7);
        // 热量缺口 = (基础代谢+有效运动) - 已摄入
        const deficit = tdee > 0 ? Math.round(tdee + burned - eaten) : '--';
        const bf = day.bodyFat ? day.bodyFat.toFixed(1) + '%' : '-';
        const water = day.water || 0;
        const waterPct = waterTarget > 0 ? Math.round(water / waterTarget * 100) : 0;
        const waterColor = waterPct >= 100 ? '#2e7d32' : waterPct >= 60 ? '#f57f17' : '#c62828';
        const waterText = water > 0 ? `<span style="color:${waterColor}">${water}/${waterTarget}</span>` : '<span style="color:#999">--</span>';
        const weight = day.weight ? day.weight.toFixed(1) + 'kg' : '-';
        return `<tr><td>${d}</td><td>${weight}</td><td>${bf}</td><td>${eaten}</td><td>${tdee || '-'}</td><td>${burned}</td><td>${deficit}</td><td>${waterText}</td></tr>`;
    }).join('') || '<tr><td colspan="8" style="text-align:center;color:#999">暂无记录</td></tr>';
    
    // Chart — 补全每一天的体重（无记录时用前一天的值填充）
    const allDates = Object.keys(data.days).sort();
    var chartLabels = [], chartWeights = [], lastW = data.profile ? data.profile.weight0 : null;
    if (allDates.length > 0) {
        var start = new Date(allDates[0]), end = new Date(allDates[allDates.length - 1]);
        for (var dt = new Date(start); dt <= end; dt.setDate(dt.getDate() + 1)) {
            var ds = dt.toISOString().slice(0, 10);
            var dayW = (data.days[ds] && data.days[ds].weight) ? data.days[ds].weight : null;
            if (dayW) lastW = dayW;
            if (lastW) {
                chartLabels.push(ds);
                chartWeights.push(lastW);
            }
        }
    }
    
    if(weightChart) weightChart.destroy();
    const ctx = document.getElementById('weight-chart');
    if(chartWeights.length > 0) {
        weightChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: chartLabels,
                datasets: [{
                    label: '体重(kg)',
                    data: chartWeights,
                    borderColor: '#2e7d32',
                    backgroundColor: 'rgba(46,125,50,0.1)',
                    fill: true,
                    tension: 0.3,
                    pointRadius: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    y: { beginAtZero: false }
                }
            }
        });
    }
}

// ===== Tab & Date =====
function switchTab(name) {
    document.querySelectorAll('.tab-content').forEach(function(el) { el.style.display = 'none'; });
    document.querySelectorAll('.tab').forEach(function(el) { el.classList.remove('active'); });
    var sec = document.getElementById('sec-' + name);
    if(sec) sec.style.display = 'block';
    // data-onclick委托传el作为第二参数，但这里name是第一参数
    // 通过查找对应的tab按钮来设置active
    document.querySelectorAll('.tab').forEach(function(el) {
        if(el.getAttribute('data-onclick') === "switchTab('" + name + "')") el.classList.add('active');
    });
    if(name === 'log' || name === 'profile') { try { renderLog(); renderWeightChart(); } catch(e){} }
    if(name === 'diet') { try { renderMealPieCharts(); } catch(e){} }
}

function changeDate(delta) {
    const d = new Date(currentDate);
    d.setDate(d.getDate() + delta);
    currentDate = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
    updateAll();
}
function goToday() { currentDate = todayStr(); updateAll(); }

function updateAll() { renderLog(); 
    document.getElementById('current-date').textContent = currentDate + (currentDate === todayStr() ? ' (今天)' : '');
    const dw = getDay(currentDate).weight;
    if(dw) document.getElementById('p-weight').value = dw;
    renderExercise(); renderFood(); calcMetrics(); updateCalorie(); renderWater(); renderNutritionPanel(); loadFeedback();
}

// ===== Meal Plan Generator =====
// satiety: 饱腹感评分 1-5（5=非常饱，1=几乎不饱）
// 高蛋白、高纤维、多蔬菜 → 饱腹感高；精制碳水、液体 → 饱腹感低
var MEALS = {
    breakfast: [
        { name:'全麦吐司2片+水煮蛋2个+黄瓜', kcal:380, protein:24, grain:true, satiety:4, hema:['臻全麦吐司','盒马鸡蛋'] },
        { name:'燕麦粥(50g)+蓝莓+坚果10g+牛奶200ml', kcal:350, protein:14, grain:true, satiety:4, hema:['盒马燕麦片','草原纯酸奶'] },
        { name:'荞麦面条+水煮蛋+菠菜', kcal:370, protein:18, grain:true, satiety:4, hema:['盒马荞麦面','日日鲜菠菜'] },
        { name:'紫薯2个+即食鸡胸肉50g+豆浆', kcal:340, protein:20, grain:false, satiety:5, hema:['盒马紫薯','即食鸡胸肉','12度豆浆'] },
        { name:'全麦三明治(鸡胸+生菜+番茄)+美式咖啡', kcal:320, protein:22, grain:true, satiety:3, hema:['臻全麦吐司','即食鸡胸肉'] },
        { name:'玉米1根+鸡蛋2个+纯酸奶150g', kcal:360, protein:18, grain:false, satiety:5, hema:['拇指小玉米','草原纯酸奶'] },
    ],
    lunch_grain: [
        { name:'🌾 燕麦饭(燕麦+糙米)+清炒西兰花+白灼虾150g', kcal:480, protein:32, grain:true, satiety:5, hema:['盒马燕麦片','盒马糙米','鲜活虾'] },
        { name:'🌾 荞麦面+番茄鸡蛋卤+凉拌黄瓜', kcal:450, protein:22, grain:true, satiety:4, hema:['盒马荞麦面'] },
        { name:'🌾 藜麦沙拉碗(藜麦+鸡胸肉+牛油果+番茄+玉米粒)', kcal:470, protein:30, grain:true, satiety:4, hema:['盒马藜麦','即食鸡胸肉'] },
        { name:'🌾 全麦卷饼+牛肉片+生菜+酸奶酱', kcal:460, protein:28, grain:true, satiety:4, hema:['帕斯雀牛肉片'] },
        { name:'🌾 玉米2根+清蒸鱼150g+蒜蓉西兰花', kcal:440, protein:26, grain:true, satiety:5, hema:['拇指小玉米','盒马鲜鱼'] },
        { name:'🌾 红薯+魔芋燕麦鸡胸肉蒸饺1袋+蔬菜汤', kcal:420, protein:20, grain:true, satiety:5, hema:['盒马红薯','魔芋燕麦蒸饺'] },
    ],
    lunch_normal: [
        { name:'糙米饭半碗+清炒西兰花+白灼虾150g', kcal:480, protein:32, grain:false, satiety:4, hema:['盒马糙米','鲜活虾'] },
        { name:'少量米饭+番茄炒蛋+清炒时蔬+鸡胸肉', kcal:500, protein:30, grain:false, satiety:4, hema:['即食鸡胸肉'] },
        { name:'杂粮饭+清蒸鱼+蒜蓉菠菜', kcal:460, protein:28, grain:false, satiety:4, hema:['盒马杂粮米','盒马鲜鱼'] },
    ],
    dinner_grain: [
        { name:'🌾 燕麦粥(40g)+清蒸鲈鱼+凉拌菠菜', kcal:380, protein:28, grain:true, satiety:4, hema:['盒马燕麦片','盒马鲈鱼'] },
        { name:'🌾 荞麦面+鸡胸肉丝+黄瓜丝', kcal:370, protein:26, grain:true, satiety:4, hema:['盒马荞麦面','即食鸡胸肉'] },
        { name:'🌾 玉米1根+牛肉片沙拉', kcal:350, protein:24, grain:true, satiety:4, hema:['拇指小玉米','帕斯雀牛肉片'] },
        { name:'🌾 紫薯+鸡蛋羹+清炒西兰花', kcal:340, protein:18, grain:true, satiety:5, hema:['盒马紫薯'] },
        { name:'🌾 藜麦粥+白灼虾+番茄黄瓜沙拉', kcal:360, protein:26, grain:true, satiety:4, hema:['盒马藜麦','鲜活虾'] },
    ],
    dinner_normal: [
        { name:'少量米饭+清蒸鲈鱼+凉拌菠菜', kcal:400, protein:28, grain:false, satiety:4, hema:['盒马鲈鱼'] },
        { name:'杂粮饭小碗+牛肉西兰花+番茄蛋汤', kcal:420, protein:26, grain:false, satiety:4, hema:['帕斯雀牛肉片'] },
    ],
    snack: [
        { name:'苹果1个(200g)', kcal:100, protein:0.5, satiety:3, hema:['盒马苹果'] },
        { name:'即食鸡胸肉脆骨肠1根', kcal:50, protein:8, satiety:3, hema:['低脂鸡胸肉脆骨肠'] },
        { name:'0卡蒟蒻果冻3个', kcal:0, protein:0, satiety:2, hema:['0卡蒟蒻果冻'] },
        { name:'纯酸奶100g+蓝莓', kcal:90, protein:3, satiety:2, hema:['草原纯酸奶'] },
        { name:'风干牛肉2根', kcal:80, protein:15, satiety:4, hema:['盒马风干牛肉'] },
        { name:'猕猴桃2个', kcal:90, protein:1, satiety:2, hema:['盒马猕猴桃'] },
        { name:'鸡蛋干3小块', kcal:70, protein:7, satiety:3, hema:['全蛋鸡蛋干'] },
        { name:'黄瓜1根', kcal:25, protein:1, satiety:2, hema:[] },
    ]
};

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
// 优先选饱腹感高的（加权随机：satiety越高概率越大）
function pickWeighted(arr) {
    const weights = arr.map(x => (x.satiety || 3) * (x.satiety || 3)); // 平方加权
    const total = weights.reduce((s,w) => s+w, 0);
    let r = Math.random() * total;
    for(let i = 0; i < arr.length; i++) {
        r -= weights[i];
        if(r <= 0) return arr[i];
    }
    return arr[arr.length - 1];
}

function satietyTag(score) {
    if(score >= 4) return '<span class="satiety-tag satiety-high">饱腹★' + score + '</span>';
    if(score >= 3) return '<span class="satiety-tag satiety-mid">饱腹★' + score + '</span>';
    return '<span class="satiety-tag satiety-low">饱腹★' + score + '</span>';
}

function generateMealPlan() {
    const m = calcMetrics();
    if(!m) { alert('请先填写个人信息并保存'); return; }
    const target = m.target;
    
    // 规则：一天有且仅有一顿谷物主食（不吃米饭），随机分配给午餐或晚餐
    const grainMeal = Math.random() < 0.5 ? 'lunch' : 'dinner';
    
    const bf = pickWeighted(MEALS.breakfast);
    const lunch = grainMeal === 'lunch' ? pickWeighted(MEALS.lunch_grain) : pickWeighted(MEALS.lunch_normal);
    const dinner = grainMeal === 'dinner' ? pickWeighted(MEALS.dinner_grain) : pickWeighted(MEALS.dinner_normal);
    
    // 根据剩余热量决定加餐（优先选饱腹感高的加餐）
    const mainKcal = bf.kcal + lunch.kcal + dinner.kcal;
    const snackBudget = target - mainKcal;
    let snacks = [];
    let snackKcal = 0;
    if(snackBudget > 50) {
        const s1 = pickWeighted(MEALS.snack);
        snacks.push(s1); snackKcal += s1.kcal;
        if(snackBudget - s1.kcal > 60) {
            let s2 = pickWeighted(MEALS.snack);
            let tries = 0;
            while(s2.name === s1.name && tries < 5) { s2 = pickWeighted(MEALS.snack); tries++; }
            snacks.push(s2); snackKcal += s2.kcal;
        }
    }
    
    const totalKcal = mainKcal + snackKcal;
    const totalProtein = bf.protein + lunch.protein + dinner.protein + snacks.reduce((s,x)=>s+x.protein,0);
    // 计算全天平均饱腹感
    const allMeals = [bf, lunch, dinner, ...snacks];
    const avgSatiety = (allMeals.reduce((s,x) => s + (x.satiety||3), 0) / allMeals.length).toFixed(1);
    
    let html = '<table style="width:100%">';
    html += '<thead><tr><th>餐次</th><th>推荐内容</th><th>热量</th><th>饱腹感</th><th>盒马好物</th></tr></thead><tbody>';
    
    html += `<tr><td>🌅 <strong>早餐</strong></td><td>${bf.name}</td><td>${bf.kcal} kcal</td><td>${satietyTag(bf.satiety)}</td><td>${bf.hema.map(h=>'<span class="food-tag">'+h+'</span>').join('')}</td></tr>`;
    html += `<tr style="${grainMeal==='lunch'?'background:#f0fff0':''}"><td>☀️ <strong>午餐</strong></td><td>${lunch.name}</td><td>${lunch.kcal} kcal</td><td>${satietyTag(lunch.satiety)}</td><td>${lunch.hema.map(h=>'<span class="food-tag">'+h+'</span>').join('')}</td></tr>`;
    html += `<tr style="${grainMeal==='dinner'?'background:#f0fff0':''}"><td>🌙 <strong>晚餐</strong></td><td>${dinner.name}</td><td>${dinner.kcal} kcal</td><td>${satietyTag(dinner.satiety)}</td><td>${dinner.hema.map(h=>'<span class="food-tag">'+h+'</span>').join('')}</td></tr>`;
    
    if(snacks.length > 0) {
        const snackSatiety = Math.round(snacks.reduce((s,x)=>s+(x.satiety||3),0)/snacks.length);
        html += `<tr><td>🍵 <strong>加餐</strong></td><td>${snacks.map(s=>s.name).join(' + ')}</td><td>${snackKcal} kcal</td><td>${satietyTag(snackSatiety)}</td><td>${snacks.flatMap(s=>s.hema).map(h=>'<span class="food-tag">'+h+'</span>').join('')}</td></tr>`;
    }
    
    html += '</tbody></table>';
    
    document.getElementById('meal-plan-content').innerHTML = html;
    
    // Summary - 新增饱腹感评估
    const pctUsed = Math.round(totalKcal / target * 100);
    const statusClass = pctUsed > 100 ? 'alert-warn' : 'alert-ok';
    const grainLabel = grainMeal === 'lunch' ? '午餐' : '晚餐';
    const satietyEmoji = avgSatiety >= 4 ? '😊 很饱' : avgSatiety >= 3 ? '🙂 适中' : '😐 偏低';
    document.getElementById('meal-summary').innerHTML = `
        <div class="alert-box ${statusClass}">
            📊 <strong>餐单总计</strong>：${totalKcal} kcal（目标 ${target} kcal 的 ${pctUsed}%）| 蛋白质约 ${totalProtein}g<br>
            🌾 今日谷物餐：<strong>${grainLabel}</strong>（不含米饭）<br>
            🫄 全天饱腹感：<strong>${avgSatiety}/5 ${satietyEmoji}</strong>（高蛋白+高纤维=更饱）<br>
            💡 剩余 ${Math.max(0, target - totalKcal)} kcal 可灵活支配
        </div>
    `;
}

// ===== Water Tracker =====
var WATER_MAX = 4000;  // 满杯 4L

function getWaterTarget() {
    const w = getWeight();
    return Math.round(w * 37);  // 建议饮水量 = 体重 × 37ml
}

function addWater(ml) {
    const day = getDay(currentDate);
    day.water = Math.max(0, Math.min(WATER_MAX, (day.water || 0) + ml));
    saveData();
    renderWater();
    // 达标特效
    if(ml > 0 && day.water >= getWaterTarget() && day.water - ml < getWaterTarget()) {
        triggerWaterCelebration();
    }
}

function resetWater() {
    if(!confirm('确定重置今日饮水记录？')) return;
    getDay(currentDate).water = 0;
    saveData();
    renderWater();
}

function triggerWaterCelebration() {
    const cup = document.getElementById('water-bigcup');
    cup.classList.add('water-celebrate');
    setTimeout(() => cup.classList.remove('water-celebrate'), 800);
    // Sparkle effect
    const sparkleDiv = document.createElement('div');
    sparkleDiv.className = 'water-sparkle';
    const emojis = ['🎉','💧','✨','🌊','💦','⭐'];
    for(let i = 0; i < 8; i++) {
        const s = document.createElement('span');
        s.textContent = emojis[Math.floor(Math.random()*emojis.length)];
        s.style.left = (Math.random()*140-10) + 'px';
        s.style.top = (Math.random()*240-20) + 'px';
        s.style.animationDelay = (Math.random()*0.5) + 's';
        sparkleDiv.appendChild(s);
    }
    cup.parentElement.appendChild(sparkleDiv);
    setTimeout(() => sparkleDiv.remove(), 1500);
}

function renderWater() {
    const target = getWaterTarget();
    const day = getDay(currentDate);
    const drunk = day.water || 0;
    
    // Update stats
    document.getElementById('water-target').textContent = target;
    document.getElementById('water-drunk').textContent = drunk;
    
    // Fill level (percentage of 4L max)
    const fillPct = Math.min(100, (drunk / WATER_MAX) * 100);
    const fill = document.getElementById('water-fill');
    fill.style.height = fillPct + '%';
    
    // Fill label
    const label = document.getElementById('water-fill-label');
    if(drunk >= 1000) {
        label.textContent = (drunk/1000).toFixed(1) + ' L';
    } else {
        label.textContent = drunk + ' ml';
    }
    // Hide label if too little water (no space)
    label.style.display = fillPct < 8 ? 'none' : 'block';
    
    // Target line position
    const targetPct = Math.min(95, (target / WATER_MAX) * 100);
    document.getElementById('water-target-line').style.bottom = targetPct + '%';
    
    // Scale marks (0, 1L, 2L, 3L, 4L)
    const marks = document.getElementById('water-marks');
    marks.innerHTML = ['4L','3L','2L','1L',''].map(m => '<span class="water-mark">' + m + '</span>').join('');
    
    // Alert
    const alertDiv = document.getElementById('water-alert');
    if(drunk >= WATER_MAX) {
        alertDiv.className = 'water-alert water-great';
        alertDiv.innerHTML = '🏆 满杯！今日饮水 4L，水份满满！';
    } else if(drunk >= target * 1.2) {
        alertDiv.className = 'water-alert water-great';
        alertDiv.innerHTML = '🎉 超额完成！已喝 ' + drunk + 'ml，超出建议 ' + (drunk - target) + 'ml，身体水润润！';
    } else if(drunk >= target) {
        alertDiv.className = 'water-alert water-done';
        alertDiv.innerHTML = '✅ 达标！已完成今日饮水目标（' + target + 'ml）💪 继续保持';
    } else if(drunk > 0) {
        const remain = target - drunk;
        alertDiv.className = 'water-alert water-ok';
        alertDiv.innerHTML = '🚰 继续加油！还差 <strong>' + remain + 'ml</strong>（约 ' + Math.ceil(remain/250) + ' 杯）达标';
    } else {
        alertDiv.className = 'water-alert water-ok';
        alertDiv.innerHTML = '🚰 点击大杯或按钮记录喝水';
    }
}

// ===== Hema Products DB =====
// name, servingDesc, kcal, protein, carb, fat (per serving)
var HEMA_DB = [
    {name:'魔芋燕麦鸡胸肉蒸饺', serving:'200g', kcal:226, protein:13.2, carb:28, fat:6, sodium:680, cat:'主食'},
    {name:'臻全麦吐司(2片)', serving:'50g', kcal:112, protein:5.6, carb:20, fat:1.7, sodium:200, cat:'主食'},
    {name:'拇指小玉米(2根)', serving:'200g', kcal:228, protein:8, carb:38, fat:4.6, sodium:6, cat:'主食'},
    {name:'盒马燕麦片', serving:'50g', kcal:184, protein:6.8, carb:33, fat:3.3, sodium:3, cat:'主食'},
    {name:'盒马荞麦面', serving:'100g(干)', kcal:340, protein:13, carb:65, fat:2.5, sodium:5, cat:'主食'},
    {name:'盒马紫薯(2个)', serving:'200g', kcal:164, protein:3.2, carb:36, fat:0.4, sodium:12, cat:'主食'},
    {name:'盒马红薯(1个)', serving:'200g', kcal:180, protein:3.2, carb:42, fat:0.2, sodium:10, cat:'主食'},
    {name:'盒马糙米饭(半碗)', serving:'100g', kcal:120, protein:2.7, carb:25, fat:0.8, sodium:2, cat:'主食'},
    {name:'盒马藜麦', serving:'50g', kcal:180, protein:7, carb:32, fat:3, sodium:4, cat:'主食'},
    {name:'即食鸡胸肉', serving:'100g', kcal:133, protein:25, carb:2, fat:2.5, sodium:580, cat:'蛋白质'},
    {name:'帕斯雀牛肉片', serving:'150g', kcal:168, protein:29.6, carb:1.5, fat:5, sodium:720, cat:'蛋白质'},
    {name:'低脂鸡胸肉脆骨肠(1根)', serving:'50g', kcal:65, protein:11.2, carb:2, fat:1.5, sodium:350, cat:'蛋白质'},
    {name:'全蛋鸡蛋干(3小块)', serving:'60g', kcal:85, protein:7.9, carb:2.5, fat:5, sodium:240, cat:'蛋白质'},
    {name:'鲜活虾(白灼)', serving:'150g', kcal:131, protein:27, carb:0, fat:1.5, sodium:300, cat:'蛋白质'},
    {name:'盒马鲈鱼(清蒸)', serving:'150g', kcal:156, protein:27, carb:0, fat:4.8, sodium:120, cat:'蛋白质'},
    {name:'草原纯酸奶', serving:'150g', kcal:96, protein:4.5, carb:11.3, fat:4.1, sodium:75, cat:'蛋白质'},
    {name:'盒马鸡蛋(2个)', serving:'100g', kcal:144, protein:13, carb:1.1, fat:10, sodium:124, cat:'蛋白质'},
    {name:'12度浓醇豆浆', serving:'250ml', kcal:143, protein:13, carb:7.5, fat:6, sodium:15, cat:'蛋白质'},
    {name:'风干牛肉(2根)', serving:'40g', kcal:86, protein:16.4, carb:2, fat:1.5, sodium:400, cat:'零食'},
    {name:'0卡蒟蒻果冻(3个)', serving:'120g', kcal:0, protein:0, carb:0, fat:0, sodium:12, cat:'零食'},
    {name:'泡椒脆笋尖', serving:'80g', kcal:18, protein:1.6, carb:2, fat:0.3, sodium:520, cat:'零食'},
    {name:'西兰花(清炒)', serving:'200g', kcal:68, protein:5.6, carb:14, fat:0.8, sodium:320, cat:'蔬菜'},
    {name:'菠菜(水煮)', serving:'200g', kcal:46, protein:5.8, carb:7.2, fat:0.8, sodium:160, cat:'蔬菜'},
    {name:'黄瓜(1根)', serving:'200g', kcal:30, protein:1.4, carb:7.2, fat:0.2, sodium:6, cat:'蔬菜'},
    {name:'番茄(1个)', serving:'200g', kcal:36, protein:1.8, carb:7.8, fat:0.4, sodium:10, cat:'蔬菜'},
    {name:'苹果(1个)', serving:'200g', kcal:104, protein:0.6, carb:28, fat:0.4, sodium:2, cat:'水果'},
    {name:'猕猴桃(2个)', serving:'150g', kcal:92, protein:1.7, carb:22.5, fat:0.8, sodium:5, cat:'水果'},
];

function addHemaFood(index) {
    const h = HEMA_DB[index];
    const meal = document.getElementById('fd-meal').value;
    getDay(currentDate).foods.push({
        meal: meal,
        name: '🛒' + h.name,
        amount: h.serving,
        kcal: h.kcal,
        protein: h.protein,
        carb: h.carb,
        fat: h.fat,
        fiber: 0,
        ingredients: null
    });
    saveData(); renderFood(); renderNutritionPanel(); updateAll();
    // 提示 — data-onclick委托不提供event，用查找按钮方式
    var btns = document.querySelectorAll('[data-onclick*="addHemaFood(' + index + ')"]');
    if(btns.length) {
        var btn = btns[0];
        var orig = btn.textContent;
        btn.textContent = '✅ 已添加';
        btn.style.color = '#2e7d32';
        setTimeout(function() { btn.textContent = orig; btn.style.color = ''; }, 1500);
    }
}

// ===== 盒马食物库（内嵌 v3.2.9）=====
var _hemaDB = {"_meta": {"export_time": "2026-03-19 19:30:00", "total": 13, "description": "盒马食材营养数据库，含每100g营养值、配料表、食用记录"}, "foods": [{"name": "芹菜拌花生", "sample_amount": "200g", "per100g": {"kcal": 231.1, "protein": 7.9, "carb": 8.5, "fat": 18.4, "sodium": 169, "fiber": 3.8}, "total": {"kcal": 462, "protein": 15.8, "carb": 17.0, "fat": 36.8, "sodium": 338, "fiber": 7.6}, "ingredients": [{"role": "主料", "name": "芹菜", "weight": "≥38%"}, {"role": "主料", "name": "花生", "weight": "≥28%"}, {"role": "辅料", "name": "胡萝卜", "weight": null}, {"role": "辅料", "name": "饮用水", "weight": null}, {"role": "辅料", "name": "食用植物油", "weight": null}, {"role": "调料", "name": "食用盐", "weight": null}, {"role": "调料", "name": "辣椒", "weight": null}, {"role": "调料", "name": "味精", "weight": null}, {"role": "调料", "name": "白砂糖", "weight": null}, {"role": "调料", "name": "芝麻油", "weight": null}, {"role": "调料", "name": "鸡粉调味料", "weight": null}, {"role": "调料", "name": "鸡汁调味料", "weight": null}, {"role": "调料", "name": "香辛料", "weight": null}, {"role": "添加物", "name": "d-异抗坏血酸钠", "weight": null}, {"role": "添加物", "name": "ε-聚赖氨酸盐酸盐", "weight": null}], "source": "hema", "first_eaten": "2026-03-10", "times_eaten": 1, "needs_photo": false}, {"name": "盒马越南卷", "sample_amount": "200g", "per100g": {"kcal": 113.3, "protein": 4.7, "carb": 17.5, "fat": 2.6, "sodium": 368, "fiber": 1.5}, "total": {"kcal": 227, "protein": 9.4, "carb": 35.0, "fat": 5.2, "sodium": 736, "fiber": 3.0}, "ingredients": [{"role": "主料", "name": "越南春卷皮(木薯淀粉、大米粉、食用盐)", "weight": null}, {"role": "主料", "name": "烟熏味沙拉鸡肉(菜肴制品)", "weight": null}, {"role": "主料", "name": "胡萝卜", "weight": null}, {"role": "主料", "name": "黄瓜", "weight": null}, {"role": "主料", "name": "益生菌紫甘蓝丝(添加量5%，含乳植物乳杆菌、嗜酸乳杆菌、鼠李糖乳酪杆菌，1.8×10⁶CFU/g)", "weight": null}, {"role": "辅料", "name": "甜辣酱(复合调味料)", "weight": null}, {"role": "辅料", "name": "全蛋液", "weight": null}, {"role": "辅料", "name": "黄桃罐头(黄桃、水、白砂糖、柠檬酸)", "weight": null}, {"role": "辅料", "name": "虾仁(调味水产制品)", "weight": null}, {"role": "辅料", "name": "卷心菜", "weight": null}, {"role": "辅料", "name": "松叶鳕蟹柳(肉糜类制品)", "weight": null}, {"role": "辅料", "name": "蛋黄酱", "weight": null}, {"role": "调料", "name": "鱼露", "weight": null}, {"role": "调料", "name": "大豆油", "weight": null}, {"role": "调料", "name": "青芥辣(复合调味料)", "weight": null}, {"role": "调料", "name": "食用盐", "weight": null}], "source": "hema", "first_eaten": "2026-03-10", "times_eaten": 1, "needs_photo": false}, {"name": "魔芋燕麦鸡胸肉蒸饺", "sample_amount": "200g", "per100g": {"kcal": 112.8, "protein": 6.6, "carb": 17.0, "fat": 1.9, "sodium": 484, "fiber": 4.5}, "total": {"kcal": 226, "protein": 13.2, "carb": 34.0, "fat": 3.8, "sodium": 968, "fiber": 9.0}, "ingredients": [{"role": "主料", "name": "魔芋制品(水、魔芋精粉、海藻粉)", "weight": "≥18%"}, {"role": "主料", "name": "小麦粉", "weight": null}, {"role": "主料", "name": "鸡胸肉", "weight": "≥15%"}, {"role": "主料", "name": "杏鲍菇", "weight": "≥8%"}, {"role": "主料", "name": "上海青", "weight": "≥8%"}, {"role": "主料", "name": "木耳", "weight": "≥6%"}, {"role": "辅料", "name": "燕麦粉", "weight": "≥3%"}, {"role": "辅料", "name": "青稞粉", "weight": null}, {"role": "辅料", "name": "香菇", "weight": "≥2%"}, {"role": "辅料", "name": "大豆蛋白", "weight": null}, {"role": "辅料", "name": "植物油", "weight": null}, {"role": "调料", "name": "酿造酱油(含焦糖色)", "weight": null}, {"role": "调料", "name": "低钠盐", "weight": null}, {"role": "调料", "name": "香辛料", "weight": null}], "source": "hema", "first_eaten": "2026-03-10", "times_eaten": 1, "needs_photo": false}, {"name": "亚麻籽黑米粥", "sample_amount": "300g", "per100g": {"kcal": 36.1, "protein": 0.9, "carb": 8.0, "fat": 0.0, "sodium": 0, "fiber": 1.2}, "total": {"kcal": 108, "protein": 2.7, "carb": 24.0, "fat": 0.0, "sodium": 0, "fiber": 3.6}, "ingredients": [{"role": "辅料", "name": "水", "weight": null}, {"role": "主料", "name": "黑米", "weight": "≥20g/碗"}, {"role": "主料", "name": "紫糯米", "weight": null}, {"role": "主料", "name": "亚麻籽", "weight": "≥2g/碗"}], "source": "hema", "first_eaten": "2026-03-11", "times_eaten": 1, "needs_photo": false}, {"name": "戗面馒头", "sample_amount": "360g(4个)", "per100g": {"kcal": 226, "protein": 7.8, "carb": 45.2, "fat": 1.2, "sodium": 320, "fiber": 1.5}, "total": {"kcal": 813.6, "protein": 28.08, "carb": 162.72000000000003, "fat": 4.32, "sodium": 1152.0, "fiber": 5.4}, "ingredients": [{"role": "主料", "name": "小麦粉", "percent": "主要"}, {"role": "辅料", "name": "水", "percent": "适量"}, {"role": "辅料", "name": "酵母", "percent": "少量"}], "source": "盒马APP产品页", "verified": true, "verified_date": "2026-03-12", "needs_photo": false, "note": "360g装4个，每个约90g"}, {"name": "低GI青菜包", "sample_amount": "210g", "per100g": {"kcal": 177.1, "protein": 8.3, "carb": 22.3, "fat": 5.2, "sodium": 481, "fiber": 3.5}, "total": {"kcal": 372, "protein": 17.4, "carb": 46.8, "fat": 10.9, "sodium": 1010, "fiber": 7.4}, "ingredients": [{"role": "主料", "name": "中式预拌粉(小麦粉、白青稞米、谷朊粉、绿豆、给米、燕麦胚芽米)", "weight": null}, {"role": "主料", "name": "青菜", "weight": null}, {"role": "辅料", "name": "全脂乳粉", "weight": null}, {"role": "辅料", "name": "燕麦麸皮粉", "weight": null}, {"role": "辅料", "name": "香菇", "weight": null}, {"role": "辅料", "name": "冰蛋白", "weight": null}, {"role": "辅料", "name": "大豆油", "weight": null}, {"role": "调料", "name": "赤藓糖醇", "weight": null}, {"role": "调料", "name": "味精", "weight": null}, {"role": "调料", "name": "鸡粉调味料", "weight": null}, {"role": "调料", "name": "食用盐", "weight": null}, {"role": "添加物", "name": "白芸豆提取物", "weight": null}, {"role": "添加物", "name": "桑叶提取物", "weight": null}], "source": "hema", "first_eaten": "2026-03-11", "times_eaten": 2, "needs_photo": false}, {"name": "卤味溏心蛋", "sample_amount": "40g(1枚)", "per100g": {"kcal": 162.3, "protein": 13.4, "carb": 0.0, "fat": 12.2, "sodium": 362, "fiber": 0}, "total": {"kcal": 65, "protein": 5.4, "carb": 0.0, "fat": 4.9, "sodium": 145, "fiber": 0}, "ingredients": [{"role": "主料", "name": "鸡蛋", "weight": null}, {"role": "辅料", "name": "水", "weight": null}, {"role": "调料", "name": "复合调味料(鸡骨肉汁≥1%)", "weight": null}], "source": "hema", "brand": "盒马工坊", "origin": "江苏南通", "spec": "160g(4枚)", "first_eaten": "2026-03-11", "times_eaten": 2, "needs_photo": false}, {"name": "谷饲黄牛嫩肉(烧烤)", "sample_amount": "90g(原料)", "per100g": {"kcal": 150.0, "protein": 22.2, "carb": 2.2, "fat": 6.1, "sodium": 388.9, "fiber": 0.0}, "total": {"kcal": 135, "protein": 20, "carb": 2, "fat": 5.5, "sodium": 350, "fiber": 0}, "ingredients": [{"role": "主料", "name": "谷饲黄牛嫩肉", "weight": null}], "source": "hema", "first_eaten": "2026-03-12", "times_eaten": 2, "needs_photo": true}, {"name": "糙米饭", "sample_amount": "180g", "per100g": {"kcal": 141.7, "protein": 3.3, "carb": 31.5, "fat": 0.0, "sodium": 22.2, "fiber": 1.8}, "total": {"kcal": 255, "protein": 5.9, "carb": 56.7, "fat": 0, "sodium": 40, "fiber": 3.2}, "ingredients": [{"role": "主料", "name": "大米", "weight": null}, {"role": "主料", "name": "三色糙米", "weight": null}, {"role": "辅料", "name": "水", "weight": null}], "source": "hema", "first_eaten": "2026-03-12", "times_eaten": 1, "needs_photo": false}, {"name": "葱油文武笋", "sample_amount": "200g", "per100g": {"kcal": 46.0, "protein": 0.8, "carb": 3.1, "fat": 3.4, "sodium": 435.0, "fiber": 1.5}, "total": {"kcal": 92, "protein": 1.6, "carb": 6.2, "fat": 6.8, "sodium": 870, "fiber": 3}, "ingredients": [{"role": "主料", "name": "清水笋(竹笋)", "weight": 80}, {"role": "主料", "name": "莴笋", "weight": 64}, {"role": "辅料", "name": "胡萝卜", "weight": 10}, {"role": "辅料", "name": "大豆油", "weight": 8}, {"role": "调料", "name": "洋葱", "weight": 4}, {"role": "调料", "name": "食用植物调和油", "weight": null}, {"role": "调料", "name": "味精", "weight": null}, {"role": "调料", "name": "鸡精", "weight": null}, {"role": "调料", "name": "食用盐", "weight": null}], "source": "hema", "first_eaten": "2026-03-12", "times_eaten": 1, "needs_photo": false}, {"name": "素拌菜", "sample_amount": "200g", "per100g": {"kcal": 129.3, "protein": 8.8, "carb": 14.3, "fat": 4.0, "sodium": 827, "fiber": 3.5}, "total": {"kcal": 259, "protein": 17.6, "carb": 28.6, "fat": 8.0, "sodium": 1654, "fiber": 7.0}, "ingredients": [{"role": "主料", "name": "莲藕", "weight": null}, {"role": "主料", "name": "胡萝卜", "weight": null}, {"role": "主料", "name": "莴笋", "weight": null}, {"role": "主料", "name": "豆皮条(大豆、水、食用酒精)", "weight": null}, {"role": "主料", "name": "木耳", "weight": null}, {"role": "主料", "name": "花生", "weight": null}, {"role": "辅料", "name": "水", "weight": null}, {"role": "辅料", "name": "植物油", "weight": null}, {"role": "辅料", "name": "花椒油", "weight": null}, {"role": "调料", "name": "食用盐", "weight": null}, {"role": "调料", "name": "白砂糖", "weight": null}, {"role": "调料", "name": "味精", "weight": null}, {"role": "调料", "name": "鸡精调味料", "weight": null}, {"role": "调料", "name": "白芝麻", "weight": null}, {"role": "调料", "name": "清香型白酒", "weight": null}, {"role": "调料", "name": "香辛料", "weight": null}, {"role": "调料", "name": "食用香精", "weight": null}, {"role": "调料", "name": "呈味核苷酸二钠", "weight": null}], "source": "hema", "first_eaten": "2026-03-11", "times_eaten": 1, "needs_photo": false}, {"name": "香干马头菜", "sample_amount": "200g", "per100g": {"kcal": 120.0, "protein": 10.1, "carb": 3.2, "fat": 7.4, "sodium": 706.0, "fiber": 0.0}, "total": {"kcal": 240.0, "protein": 20.2, "carb": 6.4, "fat": 14.8, "sodium": 1412.0, "fiber": 0.0}, "ingredients": [{"role": "主料", "name": "香干", "weight": "≥50%"}, {"role": "主料", "name": "马头菜", "weight": "≥40%"}], "tags": ["盒马", "凉菜", "高蛋白"], "hema_price": null, "hema_url": null}, {"name": "椒麻猪肝", "sample_amount": "200g", "per100g": {"kcal": 317.5, "protein": 14.4, "carb": 6.5, "fat": 26.4, "sodium": 543.0, "fiber": 0.0}, "total": {"kcal": 635.0, "protein": 28.8, "carb": 13.0, "fat": 52.8, "sodium": 1086.0, "fiber": 0.0}, "ingredients": [{"role": "主料", "name": "猪肝", "weight": "≥60%"}, {"role": "辅料", "name": "花椒", "weight": null}], "tags": ["盒马", "熟食", "高蛋白"], "times_eaten": 1, "needs_photo": false}]};
function loadHemaDB() {
    renderHemaDB();
    console.log('[hema] 数据已加载（内嵌），共' + (_hemaDB.foods ? _hemaDB.foods.length : 0) + '种食材');
}

function toggleHemaDB() {
    var list = document.getElementById('hema-db-list');
    var toggle = document.getElementById('hema-db-toggle');
    if(!list) return;
    if(list.style.display === 'none') {
        list.style.display = 'flex';
        toggle.textContent = '▼ 收起';
    } else {
        list.style.display = 'none';
        toggle.textContent = '▶ 展开';
    }
}

function renderHemaDB() {
    if(!_hemaDB) return;
    var container = document.getElementById('hema-db-list');
    var countEl = document.getElementById('hema-db-count');
    if(!container) return;
    
    // v3.3.4: 双列 feed 流
    var items = (_hemaDB.foods || []).map(function(f) { f.times_eaten = f.times_eaten || 0; return f; });
    countEl.textContent = items.length;
    
    container.style.display = 'flex';
    container.style.flexWrap = 'wrap';
    container.style.gap = '8px';
    
    var html = '';
    for(var i = 0; i < items.length; i++) {
        var item = items[i];
        var p = item.per100g || {};
        
        var tags = [];
        if(p.kcal <= 60) tags.push('🟢低卡');
        else if(p.kcal <= 120) tags.push('🟡中卡');
        else tags.push('🔴高卡');
        if(p.protein >= 10) tags.push('💪高蛋白');
        if(p.fiber >= 2) tags.push('🌾高纤');
        
        html += '<div style="background:#fff;border-radius:12px;padding:12px;border:1px solid #e8e8e8;width:calc(50% - 4px);box-sizing:border-box;cursor:pointer;transition:all 0.2s" ' +
            'onmouseover="this.style.transform=\'translateY(-2px)\';this.style.boxShadow=\'0 4px 12px rgba(0,0,0,0.1)\'" ' +
            'onmouseout="this.style.transform=\'none\';this.style.boxShadow=\'none\'" ' +
            'data-onclick="quickAddHemaFood(\'' + item.name.replace(/'/, "\'") + '\')">' +
            '<div style="font-weight:600;font-size:14px;margin-bottom:6px;color:#333">' + item.name + '</div>' +
            '<div style="font-size:20px;font-weight:bold;color:#2e7d32;margin-bottom:4px">' + Math.round(p.kcal||0) + '<span style="font-size:12px;color:#666">kcal/100g</span></div>' +
            '<div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px">' + 
            tags.map(function(t){return '<span style="font-size:10px;padding:2px 6px;background:#f0f0f0;border-radius:4px">'+t+'</span>';}).join('') + 
            '</div>' +
            '<div style="font-size:11px;color:#888;line-height:1.4">' +
            '蛋白 ' + (p.protein||0).toFixed(1) + 'g · 碳水 ' + (p.carb||0).toFixed(1) + 'g · 脂肪 ' + (p.fat||0).toFixed(1) + 'g<br>' +
            '钠 ' + Math.round(p.sodium||0) + 'mg · 纤维 ' + (p.fiber||0).toFixed(1) + 'g' +
            '</div>' +
            '</div>';
    }
    container.innerHTML = html;
}

function quickAddHemaFood(name) {
    if(!_hemaDB || !_hemaDB.foods) return;
    var item = _hemaDB.foods.find(function(f){ return f.name === name; });
    if(!item) return;
    var amt = prompt('输入重量(g)：', item.sample_amount.replace(/[^0-9.]/g,''));
    if(!amt) return;
    var grams = parseFloat(amt);
    if(!grams || grams <= 0) return;
    
    var p = item.per100g || {};
    var meal = prompt('餐次(早餐/午餐/晚餐/零食/夜宵)：', '午餐');
    if(!meal) return;
    
    var food = {
        meal: meal,
        name: '🛒' + name,
        amount: grams + 'g',
        kcal: Math.round(p.kcal * grams / 100),
        protein: Math.round(p.protein * grams / 100 * 10) / 10,
        carb: Math.round(p.carb * grams / 100 * 10) / 10,
        fat: Math.round(p.fat * grams / 100 * 10) / 10,
        sodium: Math.round(p.sodium * grams / 100),
        fiber: Math.round(p.fiber * grams / 100 * 10) / 10,
        ingredients: item.ingredients,
        source: 'hema'
    };
    
    var day = getDay(currentDate);
    if(!day.foods) day.foods = [];
    day.foods.push(food);
    saveData();
    renderFood();
    updateCalorie();
    alert('✅ 已添加 ' + food.name + ' ' + food.amount + ' (' + food.kcal + 'kcal)');
}

// 页面加载时加载盒马库
setTimeout(loadHemaDB, 1000);

function filterHema() {
    const q = document.getElementById('hema-search').value.toLowerCase();
    const rows = document.querySelectorAll('#sec-hema table tr[data-hema]');
    rows.forEach(function(row) {
        const text = row.getAttribute('data-hema').toLowerCase();
        row.style.display = !q || text.includes(q) ? '' : 'none';
    });
}

function initHemaButtons() {
    // Add quick-add buttons to hema tables and data-hema attributes
    const tables = document.querySelectorAll('#sec-hema table');
    tables.forEach(function(table) {
        const rows = table.querySelectorAll('tbody tr');
        rows.forEach(function(row) {
            const nameCell = row.cells[0];
            if(!nameCell) return;
            const name = nameCell.textContent.replace(/[🍚🥟🍞🌽🥣🍠🌾🐔🥩🌭🥚🐟🥛🥦🥒🍅🥬🍎🍿🍡🌶️🍵🍃⭐]/g,'').trim();
            row.setAttribute('data-hema', name);
            // Find matching HEMA_DB entry
            const idx = HEMA_DB.findIndex(h => name.includes(h.name.replace(/[\(（].*/,'')) || h.name.includes(name.slice(0,4)));
            if(idx >= 0) {
                const td = document.createElement('td');
                td.innerHTML = '<button class="btn btn-primary btn-sm" data-onclick="addHemaFood(' + idx + ')" style="font-size:11px;padding:2px 6px;white-space:nowrap">＋记录</button>';
                row.appendChild(td);
            }
        });
        // Add header for button column
        const thead = table.querySelector('thead tr');
        if(thead) {
            const th = document.createElement('th');
            th.textContent = '';
            thead.appendChild(th);
        }
    });
}

// ===== Feedback =====
function toggleFb(el, multi) {
    if(!multi) {
        el.parentElement.querySelectorAll('.fb-tag').forEach(t => t.classList.remove('selected'));
    }
    el.classList.toggle('selected');
}

function submitFeedback() {
    const day = getDay(currentDate);
    const fb = {};
    document.querySelectorAll('.fb-group').forEach(function(group) {
        const key = group.dataset.key;
        const isMulti = group.classList.contains('fb-multi');
        const selected = Array.from(group.querySelectorAll('.fb-tag.selected')).map(t => t.dataset.val);
        fb[key] = isMulti ? selected : (selected[0] || null);
    });
    fb.note = document.getElementById('fb-note').value.trim();
    fb.submitted = true;
    day.feedback = fb;
    saveData();
    
    document.getElementById('fb-submit-btn').textContent = '✏️ 编辑反馈';
    document.getElementById('fb-status').textContent = '✅ 反馈已提交，会用于明天的个性化建议';
    document.getElementById('fb-status').style.color = '#2e7d32';
}

function loadFeedback() {
    const day = getDay(currentDate);
    const fb = day.feedback || {};
    
    document.querySelectorAll('.fb-group').forEach(function(group) {
        const key = group.dataset.key;
        const val = fb[key];
        group.querySelectorAll('.fb-tag').forEach(function(tag) {
            if(Array.isArray(val)) {
                tag.classList.toggle('selected', val.includes(tag.dataset.val));
            } else {
                tag.classList.toggle('selected', tag.dataset.val === val);
            }
        });
    });
    
    document.getElementById('fb-note').value = fb.note || '';
    
    if(fb.submitted) {
        document.getElementById('fb-submit-btn').textContent = '✏️ 编辑反馈';
        document.getElementById('fb-status').textContent = '✅ 反馈已提交';
        document.getElementById('fb-status').style.color = '#2e7d32';
    } else {
        document.getElementById('fb-submit-btn').textContent = '📤 提交反馈';
        document.getElementById('fb-status').textContent = '';
    }
}

// ===== 饮食排序 =====
var currentFoodSort = 'time';
function sortFoods(type) {
    currentFoodSort = type;
    document.querySelectorAll('.fd-sort-btn').forEach(b => b.classList.toggle('active', b.dataset.sort === type));
    renderFood();
}

// ===== 盒马渐进加载 =====
function loadMoreHema(btn) {
    var cat = btn.parentElement;
    var rows = cat.querySelectorAll('.hema-more-row');
    var total = rows.length;
    var visibleCount = 0;
    for(var j = 0; j < total; j++) { if(rows[j].style.display === 'table-row') visibleCount++; }
    var batch = 3;
    var newlyShown = 0;
    for(var i = 0; i < total && newlyShown < batch; i++) {
        if(rows[i].style.display !== 'table-row') {
            rows[i].style.display = 'table-row';
            newlyShown++;
        }
    }
    visibleCount += newlyShown;
    if(visibleCount >= total) {
        btn.textContent = '👆 已显示全部';
        btn.style.color = '#888';
        btn.removeAttribute('data-onclick');
    } else {
        btn.textContent = '👇 查看更多 (剩余' + (total - visibleCount) + '个)';
    }
}
// 初始化盒马按钮文字
function initHemaMore() {
    document.querySelectorAll('.hema-cat').forEach(function(cat) {
        var rows = cat.querySelectorAll('.hema-more-row');
        var btn = cat.querySelector('.hema-more');
        if(btn && rows.length > 0) {
            btn.textContent = '👇 查看更多 (' + rows.length + '个)';
        } else if(btn) {
            btn.style.display = 'none';
        }
    });
}

// ===== 食物PK =====
function loadPkOptions(side) {
    const source = document.getElementById('pk-source-' + side).value;
    const select = document.getElementById('pk-food-' + side);
    select.innerHTML = '<option value="">-- 选择食物 --</option>';
    
    if(source === 'history') {
        // 从历史记录中获取不重复的食物
        const seen = {};
        Object.values(data.days).forEach(function(day) {
            (day.foods || []).forEach(function(f) {
                const name = stripSrc(f.name);
                if(!seen[name] && f.kcal) {
                    seen[name] = f;
                }
            });
        });
        Object.keys(seen).sort().forEach(function(name) {
            const opt = document.createElement('option');
            opt.value = 'h:' + name;
            opt.textContent = name;
            select.appendChild(opt);
        });
    } else {
        HEMA_DB.forEach(function(h, i) {
            const opt = document.createElement('option');
            opt.value = 'm:' + i;
            opt.textContent = h.name;
            select.appendChild(opt);
        });
    }
}

function getPkFood(val) {
    if(!val) return null;
    if(val.startsWith('h:')) {
        const name = val.slice(2);
        var found = null;
        Object.values(data.days).forEach(function(day) {
            (day.foods || []).forEach(function(f) {
                if(stripSrc(f.name) === name && !found) found = f;
            });
        });
        return found;
    } else if(val.startsWith('m:')) {
        const idx = parseInt(val.slice(2));
        const h = HEMA_DB[idx];
        return { name: h.name, kcal: h.kcal, protein: h.protein, carb: h.carb, fat: h.fat, amount: h.serving };
    }
    return null;
}

function renderPk() {
    const a = getPkFood(document.getElementById('pk-food-a').value);
    const b = getPkFood(document.getElementById('pk-food-b').value);
    const div = document.getElementById('pk-result');
    
    if(!a || !b) {
        div.innerHTML = '<p style="color:#888;text-align:center">请选择两种食物进行对比</p>';
        return;
    }
    
    // 换算为每100g
    const gA = extractGrams(a.amount) || 100;
    const gB = extractGrams(b.amount) || 100;
    
    function per100(val, g) { return val ? Math.round(val / g * 100 * 10) / 10 : 0; }
    function cmp(va, vb, lower) {
        if(va === vb) return ['', ''];
        if(lower) return va < vb ? ['pk-better', 'pk-worse'] : ['pk-worse', 'pk-better'];
        return va > vb ? ['pk-better', 'pk-worse'] : ['pk-worse', 'pk-better'];
    }
    
    const rows = [
        { label: '热量', unit: 'kcal', a: per100(a.kcal, gA), b: per100(b.kcal, gB), lower: true },
        { label: '蛋白质', unit: 'g', a: per100(a.protein, gA), b: per100(b.protein, gB), lower: false },
        { label: '碳水化合物', unit: 'g', a: per100(a.carb, gA), b: per100(b.carb, gB), lower: true },
        { label: '脂肪', unit: 'g', a: per100(a.fat, gA), b: per100(b.fat, gB), lower: true },
    ];
    
    var html = '<table><thead><tr><th>指标(每100g)</th><th>🅰️ ' + stripSrc(a.name) + '</th><th>🅱️ ' + stripSrc(b.name) + '</th></tr></thead><tbody>';
    rows.forEach(function(r) {
        const [clsA, clsB] = cmp(r.a, r.b, r.lower);
        html += '<tr><td>' + r.label + '</td><td class="' + clsA + '">' + r.a + ' ' + r.unit + '</td><td class="' + clsB + '">' + r.b + ' ' + r.unit + '</td></tr>';
    });
    html += '</tbody></table>';
    
    // 总结
    var summary = '';
    const kcalA = per100(a.kcal, gA), kcalB = per100(b.kcal, gB);
    const protA = per100(a.protein, gA), protB = per100(b.protein, gB);
    if(kcalA < kcalB && protA > protB) {
        summary = '🏆 <strong>' + stripSrc(a.name) + '</strong> 更优：热量更低、蛋白更高！';
    } else if(kcalB < kcalA && protB > protA) {
        summary = '🏆 <strong>' + stripSrc(b.name) + '</strong> 更优：热量更低、蛋白更高！';
    } else if(kcalA < kcalB) {
        summary = '💡 <strong>' + stripSrc(a.name) + '</strong> 热量更低（-' + Math.round(kcalB - kcalA) + 'kcal/100g）';
    } else if(kcalB < kcalA) {
        summary = '💡 <strong>' + stripSrc(b.name) + '</strong> 热量更低（-' + Math.round(kcalA - kcalB) + 'kcal/100g）';
    } else {
        summary = '📊 两者热量相近，根据口味和其他营养素选择';
    }
    html += '<div class="alert-box alert-ok" style="margin-top:12px">' + summary + '</div>';
    
    div.innerHTML = html;
}

// ===== Daily Tips =====
var DAILY_TIPS_URL = 'https://raw.githubusercontent.com/ykw15/jianzhi-assistant/main/daily-tips.json';
var DAILY_TIPS_KEY = 'health_daily_tips_v1';

function loadDailyTips() {
    // 先显示缓存
    const stored = localStorage.getItem(DAILY_TIPS_KEY);
    if(stored) {
        try { const tips = JSON.parse(stored); if(tips.date) renderDailyTips(tips); } catch(e) {}
    }
    // 然后从远端拉最新的
    fetch(DAILY_TIPS_URL + '?t=' + Date.now())
        .then(r => r.ok ? r.json() : Promise.reject())
        .then(tips => {
            if(tips && tips.date) {
                localStorage.setItem(DAILY_TIPS_KEY, JSON.stringify(tips));
                renderDailyTips(tips);
            }
        })
        .catch(() => {}); // 网络失败就用缓存
}

function renderDailyTips(tips) {
    document.getElementById('daily-date').textContent = tips.date + ' 更新';
    
    let html = '';
    
    // 昨日回顾
    if(tips.review) {
        html += '<div style="margin-bottom:16px">';
        html += '<h4 style="margin-bottom:8px">📊 昨日回顾</h4>';
        html += '<div class="metric-grid">';
        if(tips.review.calories) html += '<div class="metric-card"><div class="mv" style="font-size:16px">' + tips.review.calories + '</div><div class="ml">摄入 kcal</div></div>';
        if(tips.review.exercise) html += '<div class="metric-card"><div class="mv" style="font-size:16px">' + tips.review.exercise + '</div><div class="ml">运动消耗</div></div>';
        if(tips.review.deficit) html += '<div class="metric-card"><div class="mv" style="font-size:16px">' + tips.review.deficit + '</div><div class="ml">热量缺口</div></div>';
        if(tips.review.water) html += '<div class="metric-card"><div class="mv" style="font-size:16px">' + tips.review.water + '</div><div class="ml">饮水 ml</div></div>';
        html += '</div>';
        if(tips.review.summary) html += '<div class="alert-box ' + (tips.review.grade === 'good' ? 'alert-ok' : tips.review.grade === 'warn' ? 'alert-warn' : 'alert-over') + '" style="margin-top:8px">' + tips.review.summary + '</div>';
        html += '</div>';
    }
    
    // 今日重点建议
    if(tips.keyAdvice) {
        html += '<div style="margin-bottom:16px">';
        html += '<h4 style="margin-bottom:8px">🎯 今日重点</h4>';
        tips.keyAdvice.forEach(function(a) {
            html += '<div class="alert-box alert-ok" style="margin-bottom:6px">' + a + '</div>';
        });
        html += '</div>';
    }
    
    // 实用小技巧
    if(tips.tricks) {
        html += '<div style="margin-bottom:16px">';
        html += '<h4 style="margin-bottom:8px">💡 今日小技巧</h4>';
        tips.tricks.forEach(function(t) {
            html += '<div class="tip-box" style="margin-bottom:6px">' + t + '</div>';
        });
        html += '</div>';
    }
    
    // 运动建议
    if(tips.exercisePlan) {
        html += '<div style="margin-bottom:16px">';
        html += '<h4 style="margin-bottom:8px">🏋️ 今日运动建议</h4>';
        html += '<div class="alert-box alert-ok">' + tips.exercisePlan + '</div>';
        html += '</div>';
    }
    
    // 注意事项
    if(tips.warnings && tips.warnings.length > 0) {
        html += '<div style="margin-bottom:16px">';
        html += '<h4 style="margin-bottom:8px">⚠️ 注意事项</h4>';
        tips.warnings.forEach(function(w) {
            html += '<div class="alert-box alert-warn" style="margin-bottom:6px">' + w + '</div>';
        });
        html += '</div>';
    }
    
    // 激励语
    if(tips.motivation) {
        html += '<div style="text-align:center;padding:12px;font-size:15px;color:#2e7d32;font-weight:600">' + tips.motivation + '</div>';
    }
    
    document.getElementById('daily-content').innerHTML = html || '<p style="color:#999;text-align:center">暂无建议</p>';
}

// ===== Init =====
function appInit() {
    try {
        currentDate = todayStr();
        data = loadData();
        loadProfile(); updateAll(); renderWater(); loadDailyTips(); initHemaButtons(); initHemaMore(); updateFoodHistoryList(); loadPkOptions('a'); loadPkOptions('b');
    } catch(e) { console.warn('[init] error:', e); }

    // Initial cloud sync
    _syncing = false;
    _syncEnabled = false;
    cloudSync().then(function() {
        _syncEnabled = true;
        // Re-render after cloud sync brings in fresh data
        try { loadProfile(); calcMetrics(); updateAll(); renderWater(); } catch(e) {}
        console.log('[sync] Initial sync done, auto-sync enabled');
    }).catch(function(e) {
        _syncEnabled = true;
        console.warn('[sync] init error:', e);
        setSyncStatus('error');
    });

    // Auto generate meal plan if profile exists
    if(data.profile.height) { try { generateMealPlan(); } catch(e){} }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', appInit);
} else {
    appInit();
}


// ===== Food Quick Select Functions =====

var _quickPickItems = []; // Store items for filtering

function renderQuickPick() {
    var source = document.getElementById('fd-quick-source').value;
    var picker = document.getElementById('fd-quick-pick');
    var keyword = (document.getElementById('fd-quick-search').value || '').trim().toLowerCase();
    picker.innerHTML = '';
    _quickPickItems = [];

    var items = [];
    if (source === 'hema') {
        for (var i = 0; i < HEMA_DB.length; i++) {
            var h = HEMA_DB[i];
            items.push({
                name: h.name, amount: h.serving || '100g',
                kcal: h.kcal || 0, protein: h.protein || 0, carb: h.carb || 0,
                fat: h.fat || 0, sodium: h.sodium || 0, source: 'hema', _type: 'hema', _idx: i
            });
        }
    } else {
        // history - 从所有天的食物里提取，去重
        var allDays = data.days || {};
        var dates = Object.keys(allDays).sort().reverse();
        var seen = {};
        for (var d = 0; d < dates.length; d++) {
            var dayFoods = allDays[dates[d]].foods || [];
            for (var fi = 0; fi < dayFoods.length; fi++) {
                var food = dayFoods[fi];
                var key = stripSrc(food.name) + '|' + (food.amount || '');
                if (seen[key]) continue;
                seen[key] = true;
                items.push({
                    name: stripSrc(food.name), amount: food.amount || '100g',
                    kcal: food.kcal || 0, protein: food.protein || 0, carb: food.carb || 0,
                    fat: food.fat || 0, sodium: food.sodium || 0, source: food.source || '',
                    _type: 'hist', date: dates[d]
                });
            }
        }
    }

    _quickPickItems = items;

    // 过滤
    var filtered = keyword ? items.filter(function(it) {
        return it.name.toLowerCase().indexOf(keyword) !== -1;
    }) : items;

    if (filtered.length === 0) {
        picker.innerHTML = '<span style="font-size:12px;color:#999">暂无匹配食物</span>';
        return;
    }

    // 渲染为按钮标签
    for (var j = 0; j < filtered.length && j < 50; j++) {
        var it = filtered[j];
        var btn = document.createElement('span');
        btn.style.cssText = 'display:inline-block;padding:4px 8px;background:#fff;border:1px solid #ddd;border-radius:14px;font-size:11px;cursor:pointer;white-space:nowrap;transition:all .15s';
        btn.textContent = it.name + ' ' + it.amount + ' ' + Math.round(it.kcal) + 'kcal';
        btn.dataset.idx = j;
        btn.dataset.source = source;
        btn.setAttribute('data-onclick', 'quickPickSelect(' + j + ')');
        btn.onmouseenter = function() { this.style.background = '#e8f5e9'; this.style.borderColor = '#4caf50'; };
        btn.onmouseleave = function() { this.style.background = '#fff'; this.style.borderColor = '#ddd'; };
        picker.appendChild(btn);
    }
    if (filtered.length > 50) {
        var more = document.createElement('span');
        more.style.cssText = 'font-size:11px;color:#999;padding:4px';
        more.textContent = '还有 ' + (filtered.length - 50) + ' 项，搜索缩小范围';
        picker.appendChild(more);
    }
}

var _lastFilteredItems = []; // 缓存最近一次渲染的filtered列表

function quickPickSelect(idx) {
    var it = _lastFilteredItems[idx];
    if (!it) return;
    fillFoodFormFromItem(it);
}

// 存储当前选中食物的per100基准数据
var _fdPer100 = null;

function fillFoodFormFromItem(it) {
    document.getElementById('fd-name').value = it.name;
    var parsed = parseAmount(it.amount);
    var qty = parsed.qty;
    var unit = parsed.unit;

    // 设置份量
    document.getElementById('fd-qty').value = qty;
    var unitSel = document.getElementById('fd-amt-unit');
    for (var i = 0; i < unitSel.options.length; i++) {
        if (unitSel.options[i].value === unit) { unitSel.selectedIndex = i; break; }
    }

    // 计算每100g基准（从总量数据反推）
    var grams = qty || 100;
    _fdPer100 = {
        kcal: Math.round(it.kcal / grams * 100 * 10) / 10,
        protein: Math.round((it.protein || 0) / grams * 100 * 10) / 10,
        carb: Math.round((it.carb || 0) / grams * 100 * 10) / 10,
        fat: Math.round((it.fat || 0) / grams * 100 * 10) / 10,
        sodium: Math.round((it.sodium || 0) / grams * 100),
        origQty: qty
    };

    // 显示per100参考行
    var refEl = document.getElementById('fd-per100-ref');
    if (refEl) {
        refEl.style.display = 'block';
        refEl.innerHTML = '📋 <b>每100g</b>：' + _fdPer100.kcal + 'kcal | 蛋白 ' + _fdPer100.protein + 'g | 碳水 ' + _fdPer100.carb + 'g | 脂肪 ' + _fdPer100.fat + 'g' + (_fdPer100.sodium ? ' | 钠 ' + _fdPer100.sodium + 'mg' : '');
    }
    var hintEl = document.getElementById('fd-per100-hint');
    if (hintEl) hintEl.style.display = 'block';

    // 填入总量数据（按当前qty换算）
    _fdFillByQty(qty);

    // source
    var srcSel = document.getElementById('fd-source');
    if (it.source && srcSel) {
        for (var i = 0; i < srcSel.options.length; i++) {
            if (srcSel.options[i].value === it.source) { srcSel.selectedIndex = i; break; }
        }
    }

    // 设为总量模式
    document.getElementById('fd-input-mode').value = 'total';
}

// 根据重量和per100基准换算并填入表单
function _fdFillByQty(qty) {
    if (!_fdPer100) return;
    var ratio = (qty || 0) / 100;
    var kcalEl = document.getElementById('fd-kcal');
    if (kcalEl) kcalEl.value = Math.round(_fdPer100.kcal * ratio);
    var pEl = document.getElementById('fd-protein');
    if (pEl) pEl.value = Math.round(_fdPer100.protein * ratio * 10) / 10;
    var cEl = document.getElementById('fd-carb');
    if (cEl) cEl.value = Math.round(_fdPer100.carb * ratio * 10) / 10;
    var fEl = document.getElementById('fd-fat');
    if (fEl) fEl.value = Math.round(_fdPer100.fat * ratio * 10) / 10;
    var sEl = document.getElementById('fd-sodium');
    if (sEl) sEl.value = Math.round(_fdPer100.sodium * ratio);
}

// 重量变化时自动换算
function onFoodQtyChange() {
    if (!_fdPer100) return; // 只有从下拉选中时才自动换算
    var qty = parseFloat(document.getElementById('fd-qty').value) || 0;
    _fdFillByQty(qty);
}

// 清空per100状态（手动输入时）
// 编辑弹窗的per100基准
var _editPer100 = null;

function onEditFoodQtyChange() {
    if (!_editPer100) return;
    var qty = parseFloat(document.getElementById('edit-fd-qty').value) || 0;
    var ratio = qty / 100;
    var kcalEl = document.getElementById('edit-fd-kcal');
    if (kcalEl) kcalEl.value = Math.round(_editPer100.kcal * ratio);
    var pEl = document.getElementById('edit-fd-protein');
    if (pEl) pEl.value = Math.round(_editPer100.protein * ratio * 10) / 10;
    var cEl = document.getElementById('edit-fd-carb');
    if (cEl) cEl.value = Math.round(_editPer100.carb * ratio * 10) / 10;
    var fEl = document.getElementById('edit-fd-fat');
    if (fEl) fEl.value = Math.round(_editPer100.fat * ratio * 10) / 10;
    var sEl = document.getElementById('edit-fd-sodium');
    if (sEl) sEl.value = Math.round(_editPer100.sodium * ratio);
}

function clearPer100State() {
    _fdPer100 = null;
    var refEl = document.getElementById('fd-per100-ref');
    if (refEl) refEl.style.display = 'none';
    var hintEl = document.getElementById('fd-per100-hint');
    if (hintEl) hintEl.style.display = 'none';
}

// === 食物名称自动补全下拉 ===
var _foodDropdownItems = [];

function onFoodNameInput() {
    var keyword = (document.getElementById('fd-name').value || '').trim().toLowerCase();
    var source = document.getElementById('fd-quick-source').value;
    var dropdown = document.getElementById('fd-dropdown');
    if (!dropdown) return;

    // 构建候选列表
    var items = [];

    // 历史记录（去重）
    if (source === 'all' || source === 'history') {
        var allDays = data.days || {};
        var dates = Object.keys(allDays).sort().reverse();
        var seen = {};
        for (var d = 0; d < dates.length; d++) {
            var dayFoods = allDays[dates[d]].foods || [];
            for (var fi = 0; fi < dayFoods.length; fi++) {
                var food = dayFoods[fi];
                var key = stripSrc(food.name) + '|' + (food.amount || '');
                if (seen[key]) continue;
                seen[key] = true;
                items.push({
                    name: stripSrc(food.name), amount: food.amount || '100g',
                    kcal: food.kcal || 0, protein: food.protein || 0, carb: food.carb || 0,
                    fat: food.fat || 0, sodium: food.sodium || 0, source: food.source || '',
                    tag: '📝'
                });
            }
        }
    }

    // 盒马数据库
    if (source === 'all' || source === 'hema') {
        for (var i = 0; i < HEMA_DB.length; i++) {
            var h = HEMA_DB[i];
            items.push({
                name: h.name, amount: h.serving || '100g',
                kcal: h.kcal || 0, protein: h.protein || 0, carb: h.carb || 0,
                fat: h.fat || 0, sodium: h.sodium || 0, source: 'hema',
                tag: '🛒'
            });
        }
    }

    _foodDropdownItems = items;

    // 过滤（空关键词也显示，让用户浏览）
    var filtered = keyword ? items.filter(function(it) {
        return it.name.toLowerCase().indexOf(keyword) !== -1;
    }) : items;
    _lastFilteredItems = filtered; // 缓存给quickPickSelect用

    // 如果没结果或关键词为空且没聚焦，隐藏
    if (filtered.length === 0) {
        dropdown.style.display = 'none';
        return;
    }

    // 渲染下拉列表
    dropdown.innerHTML = '';
    dropdown.style.display = 'block';
    var max = Math.min(filtered.length, 20);
    for (var j = 0; j < max; j++) {
        var it = filtered[j];
        var row = document.createElement('div');
        row.style.cssText = 'padding:10px 12px;cursor:pointer;border-bottom:1px solid #f0f0f0;transition:background .1s';
        row.onmouseenter = function() { this.style.background = '#e8f5e9'; };
        row.onmouseleave = function() { this.style.background = ''; };

        // 第一行：来源标签 + 食物名 + 份量 + 热量
        var line1 = document.createElement('div');
        line1.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:3px';

        var nameSpan = document.createElement('span');
        nameSpan.style.cssText = 'font-size:13px;font-weight:500;flex:1';
        var displayName = it.tag + ' ' + it.name;
        if (keyword) {
            var idx = it.name.toLowerCase().indexOf(keyword);
            if (idx >= 0) {
                displayName = it.tag + ' ' + it.name.substring(0, idx) + '<b style="color:#2e7d32">' + it.name.substring(idx, idx + keyword.length) + '</b>' + it.name.substring(idx + keyword.length);
            }
        }
        nameSpan.innerHTML = displayName;

        var kcalSpan = document.createElement('span');
        kcalSpan.style.cssText = 'font-size:13px;font-weight:600;color:#e65100;white-space:nowrap;margin-left:8px';
        kcalSpan.textContent = Math.round(it.kcal) + ' kcal';

        line1.appendChild(nameSpan);
        line1.appendChild(kcalSpan);

        // 第二行：份量 + 营养素详情
        var line2 = document.createElement('div');
        line2.style.cssText = 'font-size:11px;color:#888;display:flex;gap:8px';
        line2.innerHTML = '<span style="color:#555">' + it.amount + '</span>' +
            '<span>蛋白 <b>' + Math.round(it.protein * 10) / 10 + 'g</b></span>' +
            '<span>碳水 <b>' + Math.round(it.carb * 10) / 10 + 'g</b></span>' +
            '<span>脂肪 <b>' + Math.round(it.fat * 10) / 10 + 'g</b></span>' +
            (it.sodium ? '<span>钠 ' + Math.round(it.sodium) + 'mg</span>' : '');

        row.appendChild(line1);
        row.appendChild(line2);

        row.setAttribute('data-onclick', 'pickDropdownItem(' + j + ')');
        (function(item, idx) {
            var handler = function(e) {
                e.preventDefault();
                e.stopPropagation();
                selectFoodFromDropdown(item);
            };
            row.onmousedown = handler;
            row.ontouchstart = handler;
        })(it, j);

        dropdown.appendChild(row);
    }
    if (filtered.length > max) {
        var more = document.createElement('div');
        more.style.cssText = 'padding:8px 12px;text-align:center;color:#999;font-size:12px;background:#fafafa';
        more.textContent = '还有 ' + (filtered.length - max) + ' 项，继续输入缩小范围...';
        dropdown.appendChild(more);
    }
}

function pickDropdownItem(idx) {
    var it = _lastFilteredItems[idx];
    if (it) selectFoodFromDropdown(it);
}

function selectFoodFromDropdown(it) {
    var dropdown = document.getElementById('fd-dropdown');
    if (dropdown) dropdown.style.display = 'none';
    fillFoodFormFromItem(it);
}

// 点击外部关闭下拉（延迟200ms，避免touch设备点击下拉项时先被关闭）
document.addEventListener('click', function(e) {
    setTimeout(function() {
        var dropdown = document.getElementById('fd-dropdown');
        var nameInput = document.getElementById('fd-name');
        if (dropdown && nameInput && !nameInput.contains(e.target) && !dropdown.contains(e.target)) {
            dropdown.style.display = 'none';
        }
    }, 200);
});

// 聚焦时显示下拉
document.addEventListener('focusin', function(e) {
    if (e.target && e.target.id === 'fd-name') {
        onFoodNameInput();
    }
});

// 兼容旧函数名
function showFoodQuickSelect() { onFoodNameInput(); }
function renderQuickPickItems() { onFoodNameInput(); }
function filterQuickPick() { onFoodNameInput(); }

// 切换输入模式时自动换算（新增区域）
function onInputModeChange() {
    var mode = document.getElementById('fd-input-mode').value;
    var qty = parseFloat(document.getElementById('fd-qty').value) || 0;
    var grams = qty;
    var kcalEl = document.getElementById('fd-kcal');
    if(!kcalEl) return;
    
    if (mode === 'per100') {
        // 如果之前有存 per100 数据，直接用
        if (kcalEl.dataset.per100 !== undefined) {
            kcalEl.value = kcalEl.dataset.per100;
        } else if (grams > 0) {
            var kcal = parseFloat(kcalEl.value) || 0;
            kcalEl.value = Math.round(kcal / grams * 100);
            kcalEl.dataset.per100 = kcalEl.value;
        }
    } else {
        // 切换回总量
        var kcalPer100 = parseFloat(kcalEl.value) || 0;
        if (kcalEl.dataset.per100 !== undefined && grams > 0) {
            kcalEl.value = Math.round(kcalPer100 * grams / 100);
        }
    }
}

// 旧函数已合并到 renderQuickPick / quickPickSelect / fillFoodFormFromItem
function useFoodQuickSelect() { /* deprecated */ }

// ===== Weight Chart (for duplicate-removed log) =====

function renderWeightChart() {
    var canvas = document.getElementById('weight-chart');
    if (!canvas) return;
    
    var days = data.days || {};
    var allDates = Object.keys(days).sort().slice(-14); // Last 14 days
    
    // 补全每一天的体重（无记录时用前一天的值填充）
    var weights = [], labels = [];
    var lastW = data.profile ? data.profile.weight0 : null;
    if (allDates.length > 0) {
        var start = new Date(allDates[0]);
        var end = new Date(allDates[allDates.length - 1]);
        for (var dt = new Date(start); dt <= end; dt.setDate(dt.getDate() + 1)) {
            var ds = dt.toISOString().slice(0, 10);
            var dayW = (days[ds] && days[ds].weight) ? days[ds].weight : null;
            if (dayW) lastW = dayW;
            if (lastW) {
                labels.push(ds.slice(5));
                weights.push(lastW);
            }
        }
    }
    
    if (weights.length < 2) {
        // Not enough data, hide chart
        canvas.style.display = 'none';
        return;
    }
    canvas.style.display = '';
    
    // If Chart.js loaded, render it
    if (typeof Chart !== 'undefined') {
        var ctx = canvas.getContext('2d');
        if (canvas.chart) canvas.chart.destroy();
        
        canvas.chart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: '体重 (kg)',
                    data: weights,
                    borderColor: '#4CAF50',
                    backgroundColor: 'rgba(76,175,80,0.1)',
                    fill: true,
                    tension: 0.3,
                    pointRadius: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    y: { title: { display: true, text: 'kg' } }
                }
            }
        });
    }
}


// ===== URL 参数快速添加食物/运动 =====
// 食物: ?add=food&name=牛肉干&amount=40g&meal=supper&kcal=90&protein=17&carb=2.8&fat=1.1&sodium=295
// 运动: ?add=ex&name=快走&kcal=200&min=40
// 兼容旧版: ?add=1 等同于 ?add=food
// 关键：必须等云同步完成后再添加，避免覆盖已有数据
(function() {
    var params = new URLSearchParams(window.location.search);
    var addType = params.get('add');
    if (!addType) return;
    if (addType === '1') addType = 'food'; // 兼容旧版
    var name = params.get('name');
    if (!name) return;
    
    // 先清除URL参数，防止刷新重复添加
    window.history.replaceState({}, '', window.location.pathname);
    
    // 显示"正在同步"提示
    var toast = document.createElement('div');
    toast.id = 'add-toast';
    toast.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#ff9800;color:#fff;padding:12px 24px;border-radius:8px;font-size:14px;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,0.3);';
    toast.textContent = '⏳ 正在同步云端数据...';
    document.body.appendChild(toast);
    
    // 等云同步完成后再添加（最多等5秒）
    var waited = 0;
    var checkInterval = setInterval(function() {
        waited += 200;
        if (_syncEnabled || waited >= 5000) {
            clearInterval(checkInterval);
            
            // 重新加载最新数据（云同步后的）
            data = loadData();
            
            var kcal = parseFloat(params.get('kcal')) || 0;
            var toastMsg = '';
            
            if (addType === 'ex') {
                // 添加运动
                var min = parseFloat(params.get('min')) || 0;
                getDay(currentDate).exercises.push({
                    name: name, qty: min, unit: 'min', kcal: kcal, min: min
                });
                saveData(); renderExercise(); updateAll();
                toastMsg = '✅ 运动: ' + name + ' ' + min + '分钟 ' + kcal + 'kcal';
            } else {
                // 添加食物
                var meal = params.get('meal') || 'snack';
                var amount = params.get('amount') || '';
                var protein = parseFloat(params.get('protein')) || 0;
                var carb = parseFloat(params.get('carb')) || 0;
                var fat = parseFloat(params.get('fat')) || 0;
                var sodium = parseFloat(params.get('sodium')) || 0;
                var fiber = parseFloat(params.get('fiber')) || 0;
                var source = params.get('source') || '';
                
                getDay(currentDate).foods.push({
                    meal: meal, name: name, amount: amount,
                    kcal: kcal, protein: protein, carb: carb, fat: fat,
                    sodium: sodium, fiber: fiber, ingredients: null, source: source
                });
                saveData(); renderFood(); renderNutritionPanel(); updateAll(); updateFoodHistoryList();
                toastMsg = '✅ 食物: ' + name + ' ' + amount + ' ' + kcal + 'kcal';
            }
            
            // 更新提示
            toast.style.background = '#4CAF50';
            toast.textContent = toastMsg;
            setTimeout(function() { toast.remove(); }, 3000);
        }
    }, 200);
})();
