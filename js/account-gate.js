(() => {
    const state = { authorized: false, role: null, overlay: null, mode: 'login' };
    const style = document.createElement('style');
    style.textContent = `
        #student-account-gate{position:fixed;inset:0;z-index:1000000;display:grid;place-items:center;padding:1rem;background:rgba(15,23,42,.88);backdrop-filter:blur(8px)}
        #student-account-gate .gate-card{width:min(100%,520px);max-height:92vh;overflow:auto;background:#fff;border-radius:22px;padding:clamp(1.25rem,5vw,2rem);box-shadow:0 24px 80px #02061766;color:#172033}
        #student-account-gate .gate-form{display:grid;gap:.8rem;margin-top:1rem}
        #student-account-gate .gate-status{min-height:1.6em;font-weight:700}
        #student-account-gate .gate-actions{display:flex;gap:.65rem;flex-wrap:wrap;margin-top:1rem}
    `;
    document.head.append(style);

    function createOverlay() {
        if (state.overlay) return state.overlay;
        const overlay = document.createElement('div');
        overlay.id = 'student-account-gate';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-labelledby', 'student-gate-title');
        overlay.innerHTML = `
            <section class="gate-card">
                <div style="font-size:2.5rem" aria-hidden="true">🔐</div>
                <h2 id="student-gate-title" class="text-2xl font-extrabold">دخول الطلاب بموافقة المعلم</h2>
                <p class="text-muted mt-2">أنشئ حساباً أو سجّل الدخول. لن تتمكن من استخدام الأنشطة والألعاب حتى يوافق المعلم على طلبك.</p>
                <form id="student-gate-form" class="gate-form"></form>
                <p id="student-gate-status" class="gate-status text-sm mt-3" role="status" aria-live="polite"></p>
                <div class="gate-actions">
                    <button id="student-gate-switch" class="btn btn-outline btn-sm" type="button">إنشاء حساب طالب</button>
                    <button id="student-gate-signout" class="btn btn-outline btn-sm hidden" type="button">تسجيل الخروج</button>
                    <a class="btn btn-outline btn-sm" href="teacher.html">دخول المعلم</a>
                </div>
            </section>`;
        document.body.append(overlay);
        state.overlay = overlay;
        overlay.querySelector('#student-gate-switch').addEventListener('click', () => {
            state.mode = state.mode === 'login' ? 'register' : 'login';
            renderForm();
        });
        overlay.querySelector('#student-gate-signout').addEventListener('click', async () => {
            try {
                await window.classroomService.signOutStudent();
                state.mode = 'login';
                renderForm();
                setStatus('تم تسجيل الخروج من الحساب.', false);
            } catch (error) {
                setStatus(`تعذر تسجيل الخروج: ${error.message}`, true);
            }
        });
        renderForm();
        return overlay;
    }

    function setStatus(message, isError = false) {
        const status = state.overlay?.querySelector('#student-gate-status');
        if (!status) return;
        status.textContent = message;
        status.style.color = isError ? '#b91c1c' : '#047857';
    }

    function addField(form, labelText, name, type, required = true, autocomplete = '') {
        const label = document.createElement('label');
        label.className = 'form-label font-bold';
        label.htmlFor = `student-gate-${name}`;
        label.textContent = labelText;
        const input = document.createElement('input');
        input.id = `student-gate-${name}`;
        input.name = name;
        input.type = type;
        input.className = 'form-control';
        input.required = required;
        if (autocomplete) input.autocomplete = autocomplete;
        if (type === 'password') input.minLength = 8;
        form.append(label, input);
        return input;
    }

    function addClassField(form) {
        const label = document.createElement('label');
        label.className = 'form-label font-bold';
        label.htmlFor = 'student-gate-class';
        label.textContent = 'الصف والفصل';
        const select = document.createElement('select');
        select.id = 'student-gate-class';
        select.name = 'className';
        select.className = 'form-control';
        [
            'الصف الخامس (أ)',
            'الصف الخامس (ب)',
            'الصف الرابع الابتدائي',
            'الصف السادس الابتدائي'
        ].forEach(name => {
            const option = document.createElement('option');
            option.value = name;
            option.textContent = name;
            select.append(option);
        });
        form.append(label, select);
        return select;
    }

    function renderForm(existingUser = null) {
        createOverlay();
        const form = state.overlay.querySelector('#student-gate-form');
        const switchButton = state.overlay.querySelector('#student-gate-switch');
        const signOutButton = state.overlay.querySelector('#student-gate-signout');
        form.replaceChildren();
        signOutButton.classList.toggle('hidden', !existingUser);
        if (existingUser) {
            state.mode = 'request';
            const description = document.createElement('p');
            description.className = 'text-muted';
            description.textContent = 'أكمل بيانات طلبك ليظهر للمعلم لاعتماده.';
            form.append(description);
            addField(form, 'اسم الطالب', 'studentName', 'text', true, 'name');
            addClassField(form);
            switchButton.classList.add('hidden');
        } else {
            switchButton.classList.remove('hidden');
            switchButton.textContent = state.mode === 'login' ? 'إنشاء حساب طالب' : 'لدي حساب، تسجيل الدخول';
            const register = state.mode === 'register';
            if (register) addField(form, 'اسم الطالب', 'studentName', 'text', true, 'name');
            addField(form, 'البريد الإلكتروني', 'email', 'email', true, 'email');
            addField(form, 'كلمة المرور (8 أحرف على الأقل)', 'password', 'password', true,
                register ? 'new-password' : 'current-password');
            if (register) addClassField(form);
        }
        const submit = document.createElement('button');
        submit.type = 'submit';
        submit.className = 'btn btn-primary w-full mt-2';
        submit.textContent = existingUser
            ? 'إرسال طلب موافقة المعلم'
            : state.mode === 'register' ? 'إنشاء الحساب وطلب الموافقة' : 'تسجيل الدخول';
        form.append(submit);
        form.onsubmit = async event => {
            event.preventDefault();
            await submitForm(form, existingUser);
        };
    }

    function renderPendingStatus() {
        createOverlay();
        const form = state.overlay.querySelector('#student-gate-form');
        form.replaceChildren();
        state.overlay.querySelector('#student-gate-switch').classList.add('hidden');
        state.overlay.querySelector('#student-gate-signout').classList.remove('hidden');
        const refresh = document.createElement('button');
        refresh.type = 'button';
        refresh.className = 'btn btn-primary w-full';
        refresh.textContent = 'تحقق من موافقة المعلم';
        refresh.addEventListener('click', async () => {
            refresh.disabled = true;
            try {
                await checkAccess();
            } catch (error) {
                setStatus(`تعذر التحقق من حالة الحساب: ${error.message}`, true);
            } finally {
                if (refresh.isConnected) refresh.disabled = false;
            }
        });
        form.append(refresh);
        setStatus('وصل طلبك. انتظر موافقة المعلم، ثم اضغط «تحقق من موافقة المعلم».');
    }

    async function unlock(role, user, student = null) {
        state.authorized = true;
        state.role = role;
        if (role === 'student' && window.appStorage?.bindStudentAccount) {
            const changedAccount = window.appStorage.bindStudentAccount(user.id, {
                name: student.student_name,
                className: student.class_name
            });
            if (changedAccount) {
                window.location.reload();
                return;
            }
        }
        state.overlay?.remove();
        state.overlay = null;
        await window.platformContent?.load();
        window.dispatchEvent(new CustomEvent('account-access-ready', { detail: { role, user } }));
    }

    async function checkAccess() {
        const teacherClient = window.classroomService.getClient('teacher');
        const { data: teacherSession, error: teacherSessionError } = await teacherClient.auth.getSession();
        if (teacherSessionError) throw teacherSessionError;
        if (teacherSession.session && !teacherSession.session.user.is_anonymous) {
            const { data: isTeacher, error } = await teacherClient.rpc('is_classroom_teacher');
            if (error) throw error;
            if (isTeacher) return unlock('teacher', teacherSession.session.user);
        }

        const client = window.classroomService.getStudentClient();
        const { data: authData, error: authError } = await client.auth.getSession();
        if (authError) throw authError;
        const user = authData.session?.user;
        if (!user || user.is_anonymous) {
            if (user?.is_anonymous) {
                const { error } = await client.auth.signOut();
                if (error) throw error;
            }
            renderForm();
            return;
        }

        const { data: access, error } = await client
            .from('classroom_student_access')
            .select('status, student_name, class_name')
            .eq('student_id', user.id)
            .maybeSingle();
        if (error) throw error;
        if (access?.status === 'approved') {
            await unlock('student', user, access);
            return;
        }
        if (access?.status === 'pending') {
            renderPendingStatus();
            return;
        }
        if (access?.status === 'rejected') {
            renderForm(user);
            setStatus('لم تتم الموافقة على الطلب. راجع المعلم لتحديث بياناتك ثم أعد الإرسال.', true);
            return;
        }
        renderForm(user);
        setStatus('أكمل بياناتك لإرسال طلب الموافقة إلى المعلم.');
    }

    async function submitForm(form, existingUser) {
        const submit = form.querySelector('button[type="submit"]');
        submit.disabled = true;
        try {
            const values = new FormData(form);
            const studentName = String(values.get('studentName') || '').trim();
            const className = String(values.get('className') || '').trim();
            if (existingUser) {
                await window.classroomService.requestStudentAccess(studentName, className);
            } else if (state.mode === 'register') {
                const result = await window.classroomService.registerStudent(
                    String(values.get('email') || '').trim(),
                    String(values.get('password') || ''),
                    studentName,
                    className
                );
                if (result.confirmationRequired) {
                    setStatus('أرسلنا رسالة تأكيد للبريد. بعد تأكيده، سجّل الدخول وأكمل طلب موافقة المعلم.');
                    return;
                }
            } else {
                const access = await window.classroomService.loginStudent(
                    String(values.get('email') || '').trim(),
                    String(values.get('password') || '')
                );
                if (!access) {
                    renderForm(true);
                    setStatus('أكمل بيانات الطالب لإرسال طلب موافقة المعلم.');
                    return;
                }
                if (access.status === 'approved') {
                    await checkAccess();
                    return;
                }
                if (access.status === 'pending') {
                    renderPendingStatus();
                    return;
                }
                renderForm(true);
                setStatus('لم تتم الموافقة على الحساب. أعد إرسال الطلب بعد مراجعة المعلم.', true);
                return;
            }
            await checkAccess();
        } catch (error) {
            console.error('تعذر التحقق من حساب الطالب.', error);
            setStatus(`تعذر إكمال العملية: ${error.message}`, true);
        } finally {
            if (submit.isConnected) submit.disabled = false;
        }
    }

    state.ready = (async () => {
        createOverlay();
        try {
            if (!window.classroomService?.isConfigured()) {
                throw new Error('إعداد الاتصال بالحسابات غير مكتمل.');
            }
            await checkAccess();
        } catch (error) {
            console.error('تعذر التحقق من أهلية دخول المنصة.', error);
            setStatus(`المنصة مقفلة حتى يتوفر اتصال آمن بالحسابات: ${error.message}`, true);
        }
    })();

    window.accountGate = {
        get ready() { return state.ready; },
        requireAccess() {
            if (!state.authorized) {
                createOverlay();
                state.overlay.scrollIntoView({ block: 'center' });
                return false;
            }
            return true;
        }
    };
})();
