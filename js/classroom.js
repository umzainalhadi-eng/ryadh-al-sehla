class ClassroomService {
    constructor() {
        this.clients = new Map();
        this.studentClient = null;
        this.studentId = null;
        this.pollTimer = null;
    }

    isConfigured() {
        const config = window.SUPABASE_CONFIG;
        return Boolean(config?.url && config?.publishableKey);
    }

    getClient(scope = 'teacher') {
        if (!this.isConfigured()) {
            throw new Error('إعداد الاتصال السحابي غير مكتمل. أضف رابط Supabase ومفتاح anon إلى js/supabase-config.js.');
        }
        if (!window.supabase?.createClient) {
            throw new Error('تعذر تحميل مكتبة Supabase. تحقق من اتصال الإنترنت وحاول مجدداً.');
        }
        if (!this.clients.has(scope)) {
            const options = scope === 'student-auth'
                ? { auth: { storageKey: 'riyadh_classroom_student_auth_v2' } }
                : undefined;
            this.clients.set(scope, window.supabase.createClient(
                window.SUPABASE_CONFIG.url,
                window.SUPABASE_CONFIG.publishableKey,
                options
            ));
        }
        return this.clients.get(scope);
    }

    getStudentClient() {
        return this.getClient('student-auth');
    }

    async ensureStudentSession() {
        const client = this.getStudentClient();
        this.studentClient = client;
        const { data, error } = await client.auth.getUser();
        if (error) throw error;
        if (!data.user || data.user.is_anonymous) {
            throw new Error('سجّل الدخول بحساب طالب وافق عليه المعلم أولاً.');
        }
        const { data: approved, error: approvalError } = await client.rpc('is_classroom_student_approved');
        if (approvalError) throw approvalError;
        if (!approved) throw new Error('حسابك ينتظر موافقة المعلم.');
        this.studentId = data.user.id;
        return this.studentId;
    }

    async registerStudent(email, password, studentName, className) {
        const client = this.getStudentClient();
        const { data, error } = await client.auth.signUp({ email, password });
        if (error) throw error;
        if (!data.session || !data.user) {
            return { confirmationRequired: true };
        }
        const { error: requestError } = await client.rpc('request_student_access', {
            p_student_name: studentName,
            p_class_name: className
        });
        if (requestError) throw requestError;
        return { confirmationRequired: false };
    }

    async loginStudent(email, password) {
        const client = this.getStudentClient();
        const { data, error } = await client.auth.signInWithPassword({ email, password });
        if (error) throw error;
        const { data: access, error: accessError } = await client
            .from('classroom_student_access')
            .select('status, student_name, class_name')
            .eq('student_id', data.user.id)
            .maybeSingle();
        if (accessError) throw accessError;
        return access;
    }

    async requestStudentAccess(studentName, className) {
        const client = this.getStudentClient();
        const { error } = await client.rpc('request_student_access', {
            p_student_name: studentName,
            p_class_name: className
        });
        if (error) throw error;
    }

    async signOutStudent() {
        const { error } = await this.getStudentClient().auth.signOut();
        if (error) throw error;
        this.studentId = null;
    }

    async submitStudentWork({ kind, title, body, answers = [], score = null }) {
        await this.ensureStudentSession();
        const client = this.studentClient;
        const { data: userData, error: userError } = await client.auth.getUser();
        if (userError) throw userError;
        const { data: student, error: studentError } = await client
            .from('classroom_student_access')
            .select('student_name, class_name')
            .eq('student_id', userData.user.id)
            .single();
        if (studentError) throw studentError;

        const { data, error } = await client.rpc('create_classroom_thread', {
            p_student_name: student.student_name,
            p_class_name: student.class_name || '',
            p_kind: kind,
            p_title: title,
            p_body: body,
            p_answers: answers,
            p_score: score
        });
        if (error) throw error;
        return data;
    }

    async sendStudentMessage(threadId, body) {
        const studentId = await this.ensureStudentSession();
        const client = this.studentClient;
        const { error } = await client.from('classroom_messages').insert({
            thread_id: threadId,
            sender_id: studentId,
            sender_role: 'student',
            body: body.trim()
        });
        if (error) throw error;
    }

    async loginTeacher(usernameOrEmail, password) {
        const client = this.getClient();
        const identifier = usernameOrEmail.trim();
        const email = identifier.toLowerCase() === 'ali_dahan'
            ? 'alidahan@manaratalsehla.bh'
            : identifier;
        const { data, error } = await client.auth.signInWithPassword({ email, password });
        if (error) throw error;

        const { data: authorized, error: roleError } = await client.rpc('is_classroom_teacher');
        if (roleError || !authorized) {
            await client.auth.signOut();
            throw roleError || new Error('هذا الحساب غير مسجل كمعلم في إعدادات Supabase.');
        }
        return data.user;
    }

    async signOutTeacher() {
        const { error } = await this.getClient().auth.signOut();
        if (error) throw error;
    }

    async changeTeacherPassword(password) {
        if (typeof password !== 'string' || password.length < 8) {
            throw new Error('يجب أن تتكون كلمة المرور الجديدة من 8 أحرف على الأقل.');
        }
        const client = this.getClient();
        const { data: userData, error: userError } = await client.auth.getUser();
        if (userError) throw userError;
        if (!userData.user || userData.user.is_anonymous) {
            throw new Error('سجّل الدخول بحساب المعلم أولاً.');
        }
        const { data: authorized, error: roleError } = await client.rpc('is_classroom_teacher');
        if (roleError) throw roleError;
        if (!authorized) throw new Error('هذا الحساب غير مخوّل بإدارة حسابات المعلم.');

        const { error } = await client.auth.updateUser({ password });
        if (error) throw error;
    }

    async getTeacherSession() {
        if (!this.isConfigured()) return null;
        const client = this.getClient();
        const { data, error } = await client.auth.getSession();
        if (error) throw error;
        if (!data.session || data.session.user.is_anonymous) return null;
        const { data: authorized, error: roleError } = await client.rpc('is_classroom_teacher');
        if (roleError) throw roleError;
        return authorized ? data.session.user : null;
    }

    async listThreads(teacherView) {
        if (teacherView) {
            const client = this.getClient();
            const { data: role, error: roleError } = await client.rpc('is_classroom_teacher');
            if (roleError) throw roleError;
            if (!role) throw new Error('يلزم تسجيل الدخول بحساب معلم معتمد.');
        } else {
            await this.ensureStudentSession();
        }
        const client = teacherView ? this.getClient() : this.studentClient;

        const { data: threads, error: threadsError } = await client
            .from('classroom_threads')
            .select('id, student_name, class_name, kind, title, created_at')
            .order('created_at', { ascending: false });
        if (threadsError) throw threadsError;
        if (!threads?.length) return [];

        const ids = threads.map(thread => thread.id);
        const { data: messages, error: messagesError } = await client
            .from('classroom_messages')
            .select('id, thread_id, sender_role, body, answers, score, created_at')
            .in('thread_id', ids)
            .order('created_at', { ascending: true });
        if (messagesError) throw messagesError;

        const messageIds = (messages || []).map(message => message.id);
        let reactions = [];
        if (messageIds.length) {
            const { data, error } = await client
                .from('classroom_reactions')
                .select('message_id, reaction')
                .in('message_id', messageIds);
            if (error) throw error;
            reactions = data || [];
        }
        const reactionByMessage = new Map(reactions.map(item => [item.message_id, item.reaction]));
        const messagesByThread = new Map();
        (messages || []).forEach(message => {
            message.teacher_reaction = reactionByMessage.get(message.id) || '';
            const group = messagesByThread.get(message.thread_id) || [];
            group.push(message);
            messagesByThread.set(message.thread_id, group);
        });

        return threads.map(thread => ({
            ...thread,
            messages: messagesByThread.get(thread.id) || []
        }));
    }

    async sendTeacherReply(threadId, body) {
        const client = this.getClient();
        const { data: userData, error: userError } = await client.auth.getUser();
        if (userError) throw userError;
        const { error } = await client.from('classroom_messages').insert({
            thread_id: threadId,
            sender_id: userData.user.id,
            sender_role: 'teacher',
            body: body.trim()
        });
        if (error) throw error;
    }

    async setTeacherReaction(messageId, reaction) {
        const client = this.getClient();
        const { data: userData, error: userError } = await client.auth.getUser();
        if (userError) throw userError;
        const { error } = await client.from('classroom_reactions').upsert({
            message_id: messageId,
            teacher_id: userData.user.id,
            reaction,
            updated_at: new Date().toISOString()
        });
        if (error) throw error;
    }

    async listStudentAccessRequests() {
        const client = this.getClient('teacher');
        const { data: authorized, error: roleError } = await client.rpc('is_classroom_teacher');
        if (roleError) throw roleError;
        if (!authorized) throw new Error('يلزم حساب معلم معتمد لعرض طلبات الحسابات.');
        const { data, error } = await client
            .from('classroom_student_access')
            .select('student_id, student_name, class_name, status, requested_at')
            .eq('status', 'pending')
            .order('requested_at', { ascending: true });
        if (error) throw error;
        return data || [];
    }

    async reviewStudentAccessRequest(studentId, status) {
        const client = this.getClient('teacher');
        const { error } = await client.rpc('review_student_access', {
            p_student_id: studentId,
            p_status: status
        });
        if (error) throw error;
    }

    setStatus(element, message, isError = false) {
        if (!element) return;
        element.textContent = message;
        element.style.color = isError ? 'var(--danger)' : 'var(--success)';
    }

    element(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    formatDate(value) {
        return new Intl.DateTimeFormat('ar', {
            dateStyle: 'medium',
            timeStyle: 'short'
        }).format(new Date(value));
    }

    async initStudentCenter() {
        const container = document.getElementById('student-classroom');
        if (!container) return;

        const status = document.getElementById('student-classroom-status');
        document.getElementById('student-question-form')?.addEventListener('submit', async event => {
            event.preventDefault();
            const form = event.currentTarget;
            const title = document.getElementById('student-question-title').value.trim();
            const body = document.getElementById('student-question-body').value.trim();
            const kind = document.getElementById('student-question-kind').value;
            try {
                this.setStatus(status, 'جارٍ إرسال رسالتك...');
                await this.submitStudentWork({ kind, title, body });
                form.reset();
                this.setStatus(status, 'وصلت رسالتك إلى المعلم. ستظهر إجابته هنا.');
                await this.renderStudentThreads();
            } catch (error) {
                console.error('تعذر إرسال رسالة الطالب.', error);
                this.setStatus(status, `تعذر إرسال الرسالة: ${error.message}`, true);
            }
        });

        if (!this.isConfigured()) {
            this.setStatus(status, 'مركز المراسلة ينتظر إعداد Supabase. لن تُرسل البيانات قبل إضافة إعداد الاتصال.', true);
            return;
        }

        await this.ensureStudentSession().catch(error => {
            console.error('تعذر بدء جلسة الطالب السحابية.', error);
            this.setStatus(status, `تعذر الاتصال بمركز الرسائل: ${error.message}`, true);
        });
        await this.renderStudentThreads();
        this.pollTimer = window.setInterval(() => this.renderStudentThreads(), 20000);
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) this.renderStudentThreads();
        });
    }

    async renderStudentThreads() {
        const container = document.getElementById('student-threads');
        if (!container || !this.isConfigured()) return;
        const status = document.getElementById('student-classroom-status');
        try {
            const threads = await this.listThreads(false);
            container.replaceChildren();
            if (!threads.length) {
                container.append(this.element('p', 'text-muted', 'لا توجد رسائل بعد. أرسل سؤالاً للمعلم أو أكمل تدريباً ليصله تقريرك.'));
                return;
            }

            threads.forEach(thread => {
                const card = this.element('article', 'quiz-box-card mb-4');
                const header = this.element('div', 'flex justify-between items-center flex-wrap gap-2 mb-3');
                header.append(
                    this.element('h3', 'font-extrabold text-lg', `${thread.kind === 'submission' ? '📝' : '💬'} ${thread.title}`),
                    this.element('span', 'text-xs text-muted', this.formatDate(thread.created_at))
                );
                card.append(header);
                thread.messages.forEach(message => {
                    const bubble = this.element('div', 'p-3 mb-2 rounded-lg border');
                    bubble.style.background = message.sender_role === 'teacher' ? '#eff6ff' : 'var(--surface)';
                    bubble.append(
                        this.element('strong', 'text-sm', message.sender_role === 'teacher' ? '👨‍🏫 المعلم' : '🧑‍🎓 إجابتك'),
                        this.element('p', 'my-2', message.body),
                        this.element('span', 'text-xs text-muted', this.formatDate(message.created_at))
                    );
                    if (message.teacher_reaction) {
                        bubble.append(this.element('span', 'badge mt-2', message.teacher_reaction));
                    }
                    if (message.answers?.length) {
                        const details = this.element('details', 'mt-2');
                        details.append(this.element('summary', 'font-bold cursor-pointer', `عرض الإجابات (${message.answers.length})`));
                        const answerList = this.element('ol', 'mt-2');
                        message.answers.forEach(answer => {
                            answerList.append(this.element(
                                'li',
                                'text-sm mb-1',
                                `${answer.question}: ${answer.answer || 'لم يجب'}${answer.correctAnswer ? ` (الصحيح: ${answer.correctAnswer})` : ''}`
                            ));
                        });
                        details.append(answerList);
                        bubble.append(details);
                    }
                    card.append(bubble);
                });
                const replyForm = this.element('form', 'flex gap-2 mt-3 flex-wrap');
                const reply = this.element('input', 'form-control');
                reply.type = 'text';
                reply.placeholder = 'اكتب رسالة متابعة للمعلم...';
                reply.required = true;
                reply.maxLength = 5000;
                const send = this.element('button', 'btn btn-outline btn-sm', 'إرسال');
                send.type = 'submit';
                replyForm.append(reply, send);
                replyForm.addEventListener('submit', async event => {
                    event.preventDefault();
                    try {
                        await this.sendStudentMessage(thread.id, reply.value.trim());
                        this.setStatus(status, 'أُرسلت رسالتك للمعلم.');
                        await this.renderStudentThreads();
                    } catch (error) {
                        console.error('تعذر إرسال رسالة المتابعة.', error);
                        this.setStatus(status, `تعذر إرسال الرسالة: ${error.message}`, true);
                    }
                });
                card.append(replyForm);
                container.append(card);
            });
        } catch (error) {
            console.error('تعذر تحميل محادثات الطالب.', error);
            this.setStatus(status, `تعذر تحميل المحادثات: ${error.message}`, true);
        }
    }

    async initTeacherInbox() {
        const container = document.getElementById('teacher-classroom-threads');
        if (!container) return;
        await this.renderTeacherThreads();
        await this.renderStudentAccessRequests();
        window.setInterval(() => {
            if (!document.hidden) {
                this.renderTeacherThreads();
                this.renderStudentAccessRequests();
            }
        }, 20000);
    }

    async renderStudentAccessRequests() {
        const container = document.getElementById('teacher-student-access-requests');
        if (!container) return;
        const status = document.getElementById('teacher-student-access-status');
        try {
            const requests = await this.listStudentAccessRequests();
            container.replaceChildren();
            if (!requests.length) {
                container.append(this.element('p', 'text-muted', 'لا توجد طلبات موافقة معلقة.'));
                return;
            }
            requests.forEach(request => {
                const row = this.element('article', 'quiz-box-card mb-3');
                const info = this.element(
                    'p',
                    'font-bold mb-2',
                    `${request.student_name} — ${request.class_name} • ${this.formatDate(request.requested_at)}`
                );
                const actions = this.element('div', 'flex gap-2 flex-wrap');
                [
                    ['approved', '✅ موافقة'],
                    ['rejected', 'رفض الطلب']
                ].forEach(([decision, label]) => {
                    const button = this.element('button', `btn ${decision === 'approved' ? 'btn-primary' : 'btn-outline'} btn-sm`, label);
                    button.type = 'button';
                    button.addEventListener('click', async () => {
                        button.disabled = true;
                        try {
                            await this.reviewStudentAccessRequest(request.student_id, decision);
                            this.setStatus(status, decision === 'approved' ? 'تم اعتماد الحساب.' : 'تم رفض الطلب.');
                            await this.renderStudentAccessRequests();
                        } catch (error) {
                            console.error('تعذرت مراجعة طلب حساب الطالب.', error);
                            this.setStatus(status, `تعذرت مراجعة الطلب: ${error.message}`, true);
                        } finally {
                            if (button.isConnected) button.disabled = false;
                        }
                    });
                    actions.append(button);
                });
                row.append(info, actions);
                container.append(row);
            });
        } catch (error) {
            console.error('تعذر تحميل طلبات حسابات الطلاب.', error);
            this.setStatus(status, `تعذر تحميل طلبات الحسابات: ${error.message}`, true);
        }
    }

    async renderTeacherThreads() {
        const container = document.getElementById('teacher-classroom-threads');
        if (!container) return;
        const status = document.getElementById('teacher-classroom-status');
        try {
            const threads = await this.listThreads(true);
            container.replaceChildren();
            if (!threads.length) {
                container.append(this.element('p', 'text-muted', 'لا توجد إجابات أو رسائل من الطلاب بعد.'));
                return;
            }

            threads.forEach(thread => {
                const card = this.element('article', 'quiz-box-card mb-4');
                const header = this.element('div', 'flex justify-between items-center flex-wrap gap-2 mb-3');
                header.append(
                    this.element('h3', 'font-extrabold text-lg', `${thread.student_name} — ${thread.title}`),
                    this.element('span', 'text-xs text-muted', `${thread.class_name || 'دون صف'} • ${this.formatDate(thread.created_at)}`)
                );
                card.append(header);
                thread.messages.forEach(message => {
                    const bubble = this.element('div', 'p-3 mb-2 rounded-lg border');
                    bubble.style.background = message.sender_role === 'teacher' ? '#eff6ff' : 'var(--surface)';
                    bubble.append(
                        this.element('strong', 'text-sm', message.sender_role === 'teacher' ? '👨‍🏫 رد المعلم' : '🧑‍🎓 رسالة الطالب'),
                        this.element('p', 'my-2', message.body),
                        this.element('span', 'text-xs text-muted', this.formatDate(message.created_at))
                    );
                    if (message.score) {
                        bubble.append(this.element('p', 'text-sm font-bold mt-2', `النتيجة: ${message.score.correct ?? 0} من ${message.score.total ?? 0}`));
                    }
                    if (message.answers?.length) {
                        const details = this.element('details', 'mt-2');
                        details.append(this.element('summary', 'font-bold cursor-pointer', `عرض إجابات الاختبار (${message.answers.length})`));
                        const answerList = this.element('ol', 'mt-2');
                        message.answers.forEach(answer => {
                            answerList.append(this.element(
                                'li',
                                'text-sm mb-1',
                                `${answer.question}: ${answer.answer || 'لم يجب'}${answer.correctAnswer ? ` (الصحيح: ${answer.correctAnswer})` : ''}${answer.isCorrect === undefined ? '' : answer.isCorrect ? ' ✓' : ' ✗'}`
                            ));
                        });
                        details.append(answerList);
                        bubble.append(details);
                    }

                    if (message.sender_role === 'student') {
                        const reactions = this.element('div', 'flex gap-2 flex-wrap mt-2');
                        ['❤️', '👏', '⭐', '💡'].forEach(reaction => {
                            const button = this.element('button', 'btn btn-outline btn-sm', `${reaction}${message.teacher_reaction === reaction ? ' ✓' : ''}`);
                            button.type = 'button';
                            button.setAttribute('aria-label', `إضافة تفاعل ${reaction}`);
                            button.addEventListener('click', async () => {
                                try {
                                    await this.setTeacherReaction(message.id, reaction);
                                    await this.renderTeacherThreads();
                                } catch (error) {
                                    console.error('تعذر حفظ تفاعل المعلم.', error);
                                    this.setStatus(status, `تعذر حفظ التفاعل: ${error.message}`, true);
                                }
                            });
                            reactions.append(button);
                        });
                        bubble.append(reactions);
                    }
                    card.append(bubble);
                });

                const replyForm = this.element('form', 'flex gap-2 mt-3 flex-wrap');
                const reply = this.element('textarea', 'form-control');
                reply.placeholder = 'اكتب ردّك للطالب...';
                reply.required = true;
                reply.maxLength = 5000;
                reply.rows = 2;
                const send = this.element('button', 'btn btn-primary btn-sm', 'إرسال الرد');
                send.type = 'submit';
                replyForm.append(reply, send);
                replyForm.addEventListener('submit', async event => {
                    event.preventDefault();
                    try {
                        await this.sendTeacherReply(thread.id, reply.value.trim());
                        this.setStatus(status, 'أُرسل الرد للطالب.');
                        await this.renderTeacherThreads();
                    } catch (error) {
                        console.error('تعذر إرسال رد المعلم.', error);
                        this.setStatus(status, `تعذر إرسال الرد: ${error.message}`, true);
                    }
                });
                card.append(replyForm);
                container.append(card);
            });
        } catch (error) {
            console.error('تعذر تحميل صندوق رسائل المعلم.', error);
            this.setStatus(status, `تعذر تحميل الرسائل: ${error.message}`, true);
        }
    }
}

window.classroomService = new ClassroomService();

document.addEventListener('DOMContentLoaded', () => {
    window.classroomService.initStudentCenter();
});
