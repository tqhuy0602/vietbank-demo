const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── IN-MEMORY STORE ───
const users = {
    'pva@gmail.com': { name: 'PHẠM VIỆT ANH',     password: '123456', balance: 50000000, stk: '1234123412', txs: [] },
    'tma@gmail.com': { name: 'TRƯƠNG MINH ANH',   password: '234567', balance: 30000000, stk: '2345234523', txs: [] },
    'pqa@gmail.com': { name: 'PHÙNG QUỲNH ANH',   password: '345678', balance: 20000000, stk: '3456345634', txs: [] },
    'nhb@gmail.com': { name: 'NGUYỄN HOÀNG BÁCH', password: '456789', balance: 10000000, stk: '4567456745', txs: [] },
};

// Risk levels: 'safe' | 'warning' | 'danger'
const riskLevels = {
    '3456345634': {
        level: 'danger',
        reason: 'Tài khoản có dấu hiệu rủi ro cao',
        detail: 'Tài khoản nằm trong danh sách nghi ngờ gian lận, lừa đảo được phát hiện bởi hệ thống Agribank.',
        reports: 0,
    },
    '4567456745': {
        level: 'warning',
        reason: 'Tài khoản tiềm ẩn rủi ro',
        detail: 'Tài khoản có dấu hiệu bất thường, quý khách cần cân nhắc khi thực hiện giao dịch.',
        reports: 0,
    },
};

// { adminEmail: [{ email, name, stk, threshold }] }
const monitorRules = {
    'pva@gmail.com': [
        { email: 'tma@gmail.com', name: 'TRƯƠNG MINH ANH', stk: '2345234523', threshold: 1000000 },
        { email: 'pqa@gmail.com', name: 'PHÙNG QUỲNH ANH', stk: '3456345634', threshold: 5000000 },
    ]
};

// ─── HELPER: tìm user theo STK ───
function findByStk(stk) {
    return Object.entries(users).find(([, u]) => u.stk === stk);
}

// { txId: { id, from, to, amount, note, adminEmail, threshold, status, timer, expiresAt } }
const pendingTxs = {};

// email → socket.id
const online = {};

let txSeq = 0;

// ─── HELPERS ───
function dateStr() {
    const n = new Date();
    return `${String(n.getDate()).padStart(2,'0')}/${String(n.getMonth()+1).padStart(2,'0')}/${n.getFullYear()}`;
}
function txId() { return 'TX' + String(++txSeq).padStart(5,'0') + '_' + Date.now(); }

function execTransfer(from, to, amount, note) {
    const d = dateStr();
    users[from].balance -= amount;
    users[to].balance   += amount;
    users[from].txs.unshift({ type:'db', who: users[to].name,   amt: amount, date: d, note });
    users[to].txs.unshift  ({ type:'cr', who: users[from].name, amt: amount, date: d, note });
}

function notifySocket(email, event, data) {
    const sid = online[email];
    if (sid) io.to(sid).emit(event, data);
}

// ─── SOCKET ───
io.on('connection', socket => {
    socket.on('register', email => {
        online[email] = socket.id;
        socket.email  = email;

        // Send any pending txs that need this admin's approval
        const pending = Object.values(pendingTxs).filter(t => t.adminEmail === email && t.status === 'pending');
        pending.forEach(t => {
            socket.emit('pending_transaction', {
                txId:      t.id,
                from:      t.from,
                fromName:  users[t.from]?.name || t.from,
                to:        t.to,
                toName:    users[t.to]?.name || t.to,
                amount:    t.amount,
                note:      t.note,
                threshold: t.threshold,
                timeLeft:  Math.max(0, Math.round((t.expiresAt - Date.now()) / 1000)),
            });
        });
    });

    socket.on('disconnect', () => {
        if (socket.email) delete online[socket.email];
    });
});

// ─── API ───

// Login — email + password
app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Email không hợp lệ' });
    const u = users[email];
    if (!u) return res.status(404).json({ error: 'Tài khoản không tồn tại' });
    if (u.password && u.password !== String(password)) return res.status(401).json({ error: 'Mật khẩu không đúng' });
    res.json({ email, name: u.name, balance: u.balance, stk: u.stk });
});

// Get user info
app.get('/api/user/:email', (req, res) => {
    const u = users[req.params.email];
    if (!u) return res.status(404).json({ error: 'Không tìm thấy' });
    const { email } = req.params;
    res.json({ email, ...u });
});

// Risk level by STK
app.get('/api/risk/:stk', (req, res) => {
    const risk = riskLevels[req.params.stk];
    if (!risk) return res.json({ level: 'safe', reason: 'Tài khoản an toàn', detail: 'Không ghi nhận dấu hiệu bất thường.', reports: 0 });
    res.json(risk);
});

// Lookup STK
app.get('/api/lookup-stk/:stk', (req, res) => {
    const entry = findByStk(req.params.stk);
    if (!entry) return res.status(404).json({ error: 'Số tài khoản không tồn tại' });
    const [email, u] = entry;
    res.json({ email, name: u.name, stk: u.stk });
});

// Transfer — nhận toStk thay vì email
app.post('/api/transfer', (req, res) => {
    const { from, toStk, amount, note } = req.body;
    const amt = parseInt(amount);

    const toEntry = findByStk(toStk);
    const to = toEntry?.[0];

    if (!users[from])          return res.status(404).json({ error: 'Người gửi không tồn tại' });
    if (!to)                   return res.status(404).json({ error: 'Số tài khoản người nhận không tồn tại' });
    if (from === to)           return res.status(400).json({ error: 'Không thể tự chuyển cho mình' });
    if (!amt || amt < 1000)    return res.status(400).json({ error: 'Số tiền tối thiểu 1.000 ₫' });
    if (users[from].balance < amt) return res.status(400).json({ error: 'Số dư không đủ' });

    // Check if sender is being monitored by any admin
    for (const [adminEmail, rules] of Object.entries(monitorRules)) {
        const rule = rules.find(r => r.email === from);
        if (rule && amt > rule.threshold) {
            const id = txId();

            const PHASE1 = 180_000; // 3 phút admin duyệt
            const PHASE2 = 420_000; // 7 phút tự động thực hiện
            const exp = Date.now() + PHASE1;

            const tx = {
                id, from, to, amount: amt,
                note: note || 'Chuyển tiền',
                adminEmail, threshold: rule.threshold,
                status: 'pending', expiresAt: exp,
            };

            // Phase 1: hết 3 phút → chuyển sang phase 2
            tx.timer = setTimeout(() => {
                const t = pendingTxs[id];
                if (!t || t.status !== 'pending') return;
                t.status = 'auto_pending';

                // Đóng modal admin, thông báo cho sender đếm ngược 7 phút
                notifySocket(adminEmail, 'transaction_expired', { txId: id, from, amount: amt });
                notifySocket(from, 'transaction_auto_pending', { txId: id, amount: amt, autoIn: 420 });

                // Phase 2: hết 7 phút → tự động thực hiện giao dịch
                t.autoTimer = setTimeout(() => {
                    if (pendingTxs[id]?.status !== 'auto_pending') return;
                    delete pendingTxs[id];
                    execTransfer(from, to, amt, tx.note);
                    notifySocket(from, 'transfer_done',     { amount: amt, toName: users[to].name,   balance: users[from].balance });
                    notifySocket(to,   'transfer_received', { amount: amt, fromName: users[from].name, balance: users[to].balance });
                }, PHASE2);
            }, PHASE1);

            pendingTxs[id] = tx;

            notifySocket(adminEmail, 'pending_transaction', {
                txId: id,
                from,      fromName:  users[from].name,  fromStk: users[from].stk,
                to,        toName:    users[to].name,    toStk:   users[to].stk,
                amount:    amt,
                note:      tx.note,
                threshold: rule.threshold,
                timeLeft:  180,
            });

            return res.json({ status: 'pending', txId: id });
        }
    }

    // No monitoring → execute immediately
    execTransfer(from, to, amt, note || 'Chuyển tiền');
    notifySocket(from, 'transfer_done',     { amount: amt, toName: users[to].name,   balance: users[from].balance });
    notifySocket(to,   'transfer_received', { amount: amt, fromName: users[from].name, balance: users[to].balance });

    res.json({ status: 'success' });
});

// Approve
app.post('/api/approve/:id', (req, res) => {
    const tx = pendingTxs[req.params.id];
    if (!tx) return res.status(404).json({ error: 'Giao dịch không tồn tại hoặc đã hết hạn' });
    if (tx.adminEmail !== req.body.adminEmail) return res.status(403).json({ error: 'Không có quyền' });

    clearTimeout(tx.timer);
    clearTimeout(tx.autoTimer);
    delete pendingTxs[req.params.id];

    execTransfer(tx.from, tx.to, tx.amount, tx.note);

    notifySocket(tx.from, 'transfer_done', {
        amount: tx.amount, toName: users[tx.to].name, balance: users[tx.from].balance
    });

    res.json({ status: 'approved' });
});

// Reject
app.post('/api/reject/:id', (req, res) => {
    const tx = pendingTxs[req.params.id];
    if (!tx) return res.status(404).json({ error: 'Giao dịch không tồn tại hoặc đã hết hạn' });
    if (tx.adminEmail !== req.body.adminEmail) return res.status(403).json({ error: 'Không có quyền' });

    clearTimeout(tx.timer);
    clearTimeout(tx.autoTimer);
    delete pendingTxs[req.params.id];

    notifySocket(tx.from, 'transfer_rejected', { amount: tx.amount });

    res.json({ status: 'rejected' });
});

// Get monitor list (accounts I'm watching)
app.get('/api/monitor/:adminEmail', (req, res) => {
    res.json(monitorRules[req.params.adminEmail] || []);
});

// Get who is watching me
app.get('/api/monitored-by/:email', (req, res) => {
    const email = req.params.email;
    const result = [];
    for (const [adminEmail, rules] of Object.entries(monitorRules)) {
        const rule = rules.find(r => r.email === email);
        if (rule) result.push({
            email:     adminEmail,
            name:      users[adminEmail]?.name || adminEmail,
            stk:       users[adminEmail]?.stk || '',
            threshold: rule.threshold,
        });
    }
    res.json(result);
});

// Add monitor
app.post('/api/monitor', (req, res) => {
    const { adminEmail, watchEmail, threshold } = req.body;
    if (!monitorRules[adminEmail]) monitorRules[adminEmail] = [];
    if (monitorRules[adminEmail].find(r => r.email === watchEmail))
        return res.status(400).json({ error: 'Email này đã được giám sát' });

    const name = users[watchEmail]?.name || watchEmail;
    monitorRules[adminEmail].push({ email: watchEmail, name, threshold: parseInt(threshold) });
    res.json({ status: 'ok' });
});

// Remove monitor
app.delete('/api/monitor/:adminEmail/:watchEmail', (req, res) => {
    const { adminEmail, watchEmail } = req.params;
    if (monitorRules[adminEmail])
        monitorRules[adminEmail] = monitorRules[adminEmail].filter(r => r.email !== watchEmail);
    res.json({ status: 'ok' });
});

// ─── START ───
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`VietBank chạy tại http://localhost:${PORT}`));
