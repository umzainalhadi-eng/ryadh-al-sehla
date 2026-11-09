class PlatformContent {
    constructor() {
        this.items = [];
        this.client = null;
        this.loadError = null;
        this.defaultSiteNames = null;
        this.teacherProfile = null;
        this.appliedTeacherName = null;
        this.ready = this.load();
    }

    async createAuthenticatedClient() {
        const service = window.classroomService;
        if (!service?.isConfigured()) return null;
        for (const scope of ['teacher', 'student-auth']) {
            const client = service.getClient(scope);
            const { data, error } = await client.auth.getSession();
            if (error) throw error;
            if (!data.session || data.session.user.is_anonymous) continue;
            const { data: approved, error: approvalError } = await client.rpc('is_classroom_student_approved');
            if (approvalError) throw approvalError;
            if (approved) return client;
        }
        return null;
    }

    async load() {
        try {
            this.client = await this.createAuthenticatedClient();
            if (!this.client) {
                this.items = [];
                window.dispatchEvent(new CustomEvent('platform-content-ready'));
                return;
            }

            const { data, error } = await this.client
                .from('platform_content')
                .select('id, kind, title, category, payload, sort_order')
                .order('sort_order', { ascending: true })
                .order('updated_at', { ascending: true });

            if (error) throw error;
            this.items = Array.isArray(data) ? data : [];
            await this.loadTeacherProfile();
            window.dispatchEvent(new CustomEvent('platform-content-ready'));
        } catch (error) {
            this.loadError = error;
            console.error('تعذر تحميل محتوى المنصة من Supabase.', error);
            window.dispatchEvent(new CustomEvent('platform-content-error', { detail: error }));
        }
    }

    async loadTeacherProfile() {
        if (!this.client) return;
        const { data, error } = await this.client
            .from('platform_teacher_profile')
            .select('display_name')
            .eq('id', 'main')
            .maybeSingle();
        if (error) {
            console.error('تعذر تحميل اسم المعلم للمنصة.', error);
            return;
        }
        this.teacherProfile = data;
    }

    async updateTeacherName(firstName) {
        const allowedNames = ['علي', 'مؤمن', 'محمد', 'فهد', 'سلطان'];
        if (!allowedNames.includes(firstName)) throw new Error('اختر الاسم الأول من القائمة.');
        const client = window.classroomService?.getClient('teacher');
        if (!client) throw new Error('يلزم تسجيل الدخول بحساب معلم معتمد قبل تغيير الاسم.');
        const { data: userData, error: userError } = await client.auth.getUser();
        if (userError) throw userError;
        if (!userData.user || userData.user.is_anonymous) throw new Error('سجّل الدخول بحساب المعلم أولاً.');
        const { data: authorized, error: roleError } = await client.rpc('is_classroom_teacher');
        if (roleError) throw roleError;
        if (!authorized) throw new Error('هذا الحساب غير مخوّل بتغيير اسم المعلم الظاهر.');

        const displayName = `أ. ${firstName}`;
        const { data, error } = await client.from('platform_teacher_profile').upsert({
            id: 'main',
            display_name: displayName,
            updated_by: userData.user.id
        }).select('display_name').single();
        if (error) throw error;
        this.teacherProfile = data;
        this.applyTeacherName();
    }

    applyTeacherName() {
        if (!this.teacherProfile?.display_name || !document.body) return;
        const displayName = this.teacherProfile.display_name;
        const previousName = this.appliedTeacherName;
        const namesToReplace = [...new Set(['أ. علي دحان', previousName].filter(Boolean))]
            .map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const teacherNamePattern = new RegExp(namesToReplace.join('|'), 'g');
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
            if (node.parentElement?.closest('script, style, textarea, input, select, option')) continue;
            node.textContent = node.textContent.replace(teacherNamePattern, displayName);
        }
        document.title = document.title.replace(teacherNamePattern, displayName);
        this.appliedTeacherName = displayName;
    }

    getItems(kind) {
        return this.items.filter(item => item.kind === kind);
    }

    escape(value) {
        return String(value ?? '').replace(/[&<>"']/g, char => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[char]);
    }

    safeItem(item) {
        const escapeDeep = value => {
            if (typeof value === 'string') return this.escape(value);
            if (Array.isArray(value)) return value.map(escapeDeep);
            if (value && typeof value === 'object') {
                return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, escapeDeep(child)]));
            }
            return value;
        };
        return {
            ...escapeDeep(item.payload),
            id: item.id,
            title: this.escape(item.title),
            category: this.escape(item.category || item.payload?.category || ''),
            isTeacherContent: true
        };
    }

    applyAppearance() {
        this.applyTeacherName();
        const appearance = this.items.find(item => item.kind === 'appearance');
        const root = document.documentElement;
        if (!this.defaultSiteNames) {
            this.defaultSiteNames = [...document.querySelectorAll('.logo-text h1')].map(element => element.textContent);
        }
        if (!appearance) {
            ['--primary', '--secondary', '--accent'].forEach(property => root.style.removeProperty(property));
            document.querySelectorAll('.logo-text h1').forEach((element, index) => {
                element.textContent = this.defaultSiteNames[index] || this.defaultSiteNames[0] || element.textContent;
            });
            return;
        }
        const payload = appearance.payload || {};
        const colorProperties = {
            primaryColor: '--primary',
            secondaryColor: '--secondary',
            accentColor: '--accent'
        };
        Object.entries(colorProperties).forEach(([key, property]) => {
            if (/^#[0-9a-f]{6}$/i.test(payload[key] || '')) root.style.setProperty(property, payload[key]);
        });
        if (typeof payload.siteName === 'string' && payload.siteName.trim()) {
            document.querySelectorAll('.logo-text h1').forEach(element => {
                element.textContent = payload.siteName.trim();
            });
        }
    }

    async save(kind, entry) {
        const client = window.classroomService?.getClient('teacher');
        if (!client) throw new Error('يلزم تسجيل الدخول بحساب معلم معتمد قبل حفظ التعديلات.');
        const id = entry.id || (kind === 'appearance' ? 'site-appearance' : `${kind}-${crypto.randomUUID()}`);
        const { data, error } = await client.from('platform_content').upsert({
            id,
            kind,
            title: entry.title,
            category: entry.category || '',
            payload: entry.payload,
            sort_order: Number(entry.sort_order) || 0,
            updated_by: (await client.auth.getUser()).data.user?.id
        }).select('id, kind, title, category, payload, sort_order').single();
        if (error) throw error;
        this.items = [...this.items.filter(item => item.id !== data.id), data];
        this.applyAppearance();
        window.dispatchEvent(new CustomEvent('platform-content-ready'));
        return data;
    }

    async remove(id) {
        const client = window.classroomService?.getClient('teacher');
        if (!client) throw new Error('يلزم تسجيل الدخول بحساب معلم معتمد قبل حذف المحتوى.');
        const { error } = await client.from('platform_content').delete().eq('id', id);
        if (error) throw error;
        this.items = this.items.filter(item => item.id !== id);
        this.applyAppearance();
        window.dispatchEvent(new CustomEvent('platform-content-ready'));
    }

    refreshPages() {
        this.applyAppearance();
        window.gamesManager?.renderGamesGrid();
        window.gamesManager?.setupFiltersAndSearch();
        window.storiesManager?.renderStoryList();
        window.cinemaManager?.renderFilmList();
        window.app?.renderHomeSpotlight();
        const homeSections = document.getElementById('home-teacher-sections');
        if (homeSections) {
            const sections = this.getItems('section');
            homeSections.innerHTML = sections.map(item => `
                <article class="portal-card teacher-added-section">
                    <span class="teacher-added-section-icon">${this.escape(item.payload.icon || '📚')}</span>
                    <h2>${this.escape(item.title)}</h2>
                    <p>${this.escape(item.payload.description)}</p>
                    ${item.payload.link ? `<a class="btn btn-primary btn-sm" href="${this.escape(item.payload.link)}">افتح القسم</a>` : ''}
                </article>
            `).join('');
        }
        this.renderStudioList();
    }

    renderStudioList() {
        const list = document.getElementById('teacher-content-list');
        if (!list) return;
        const entries = this.items.filter(item => ['game', 'story', 'film', 'section'].includes(item.kind));
        list.innerHTML = entries.length ? entries.map(item => `
            <article class="teacher-content-row">
                <div>
                    <strong>${this.escape(item.payload.icon || '📚')} ${this.escape(item.title)}</strong>
                    <span>${this.labelFor(item.kind)}${item.category ? ` · ${this.escape(item.category)}` : ''}</span>
                </div>
                <div class="teacher-content-actions">
                    <button class="btn btn-outline btn-sm" type="button" data-content-edit="${this.escape(item.id)}">تعديل</button>
                    <button class="btn btn-outline btn-sm" type="button" data-content-delete="${this.escape(item.id)}">حذف</button>
                </div>
            </article>
        `).join('') : '<p class="text-muted">لم تُضف محتويات بعد.</p>';

        list.querySelectorAll('[data-content-edit]').forEach(button => {
            button.addEventListener('click', () => this.edit(button.dataset.contentEdit));
        });
        list.querySelectorAll('[data-content-delete]').forEach(button => {
            button.addEventListener('click', async () => {
                const item = this.items.find(entry => entry.id === button.dataset.contentDelete);
                if (!item || !window.confirm(`هل تريد حذف «${item.title}» من المنصة؟`)) return;
                try {
                    await this.remove(item.id);
                    this.setStatus('تم حذف المحتوى من المنصة لجميع المستخدمين.');
                } catch (error) {
                    console.error('تعذر حذف المحتوى.', error);
                    this.setStatus(`تعذر الحذف: ${error.message}`, true);
                }
            });
        });
    }

    labelFor(kind) {
        return ({ game: 'لعبة', story: 'قصة', film: 'فيلم', section: 'قسم', appearance: 'المظهر' })[kind] || kind;
    }

    edit(id) {
        const item = this.items.find(entry => entry.id === id);
        if (!item) return;
        const form = document.getElementById('teacher-content-form');
        if (!form) return;
        form.elements.namedItem('content-id').value = item.id;
        form.elements.namedItem('content-kind').value = item.kind;
        form.elements.namedItem('content-title').value = item.title || '';
        form.elements.namedItem('content-category').value = item.category || '';
        const payload = item.payload || {};
        form.elements.namedItem('content-icon').value = payload.icon || '';
        form.elements.namedItem('content-summary').value = payload.description || payload.summary || '';
        const reflection = payload.chapters?.find(chapter => chapter.reflectionQuestion);
        form.elements.namedItem('content-main-text').value = payload.chapters
            ?.filter(chapter => !chapter.reflectionQuestion)
            .map(chapter => chapter.text)
            .join('\n') || payload.content || '';
        form.elements.namedItem('content-question').value =
            payload.bookQuestions?.[0]?.text || payload.quiz?.question || reflection?.reflectionQuestion || '';
        form.elements.namedItem('content-options').value =
            (payload.bookQuestions?.[0]?.options || payload.quiz?.options || reflection?.options || []).join('\n');
        form.elements.namedItem('content-correct').value =
            String((payload.bookQuestions?.[0]?.correct ?? payload.quiz?.correct ?? reflection?.correctIndex ?? 0) + 1);
        form.elements.namedItem('content-scenes').value = (payload.scenes || []).map(scene => `${scene.title} | ${scene.subtitles}`).join('\n');
        form.elements.namedItem('content-link').value = payload.link || '';
        form.elements.namedItem('content-primary-color').value = payload.primaryColor || '#4f46e5';
        form.elements.namedItem('content-secondary-color').value = payload.secondaryColor || '#06b6d4';
        form.elements.namedItem('content-accent-color').value = payload.accentColor || '#f59e0b';
        this.updateFields();
        form.scrollIntoView({ behavior: 'smooth', block: 'center' });
        this.setStatus('عدّل الحقول ثم احفظ التغييرات.');
    }

    updateFields() {
        const kind = document.getElementById('teacher-content-kind')?.value;
        document.querySelectorAll('[data-content-fields]').forEach(group => {
            group.hidden = !group.dataset.contentFields.split(' ').includes(kind);
        });
        const category = document.getElementById('teacher-content-category-wrap');
        if (category) category.hidden = kind === 'appearance';
    }

    readForm(form) {
        const value = name => form.elements.namedItem(name).value.trim();
        const kind = value('content-kind');
        const title = value('content-title');
        const category = value('content-category');
        const icon = value('content-icon') || ({ game: '🎮', story: '📖', film: '🎬', section: '📚' })[kind];
        const summary = value('content-summary');
        const payload = { icon, description: summary, summary };

        if (kind === 'game') {
            const options = value('content-options').split('\n').map(option => option.trim()).filter(Boolean);
            const correct = Number(value('content-correct')) - 1;
            if (!value('content-question') || options.length < 2 || correct < 0 || correct >= options.length) {
                throw new Error('أدخل سؤال اللعبة وخيارين على الأقل ورقم الإجابة الصحيحة.');
            }
            Object.assign(payload, {
                number: 'جديدة',
                book: category || 'أنشطة المعلم',
                skill: category || 'تحدي تعليمي',
                difficulty: 'متدرج',
                objective: summary || title,
                points: 50,
                bookQuestions: [{ text: value('content-question'), options, correct }]
            });
        } else if (kind === 'story') {
            const paragraphs = value('content-main-text').split(/\n+/).map(text => text.trim()).filter(Boolean);
            if (!paragraphs.length) throw new Error('أدخل نص القصة ومشاهدها.');
            const options = value('content-options').split('\n').map(option => option.trim()).filter(Boolean);
            const correct = Number(value('content-correct')) - 1;
            if (!value('content-question') || options.length < 2 || correct < 0 || correct >= options.length) {
                throw new Error('أدخل سؤالاً ختامياً للقصة وخيارين على الأقل ورقم الإجابة الصحيحة.');
            }
            payload.category = category || 'قصص المعلم';
            payload.readTime = `${Math.max(1, Math.ceil(paragraphs.join(' ').split(/\s+/).length / 120))} دقائق`;
            payload.chapters = [
                ...paragraphs.map((text, index) => ({
                scene: index + 1,
                text,
                decisionPrompt: 'تابع إلى المشهد التالي.',
                choices: [{ text: 'تابع القصة', nextScene: index + 2 }]
                })),
                {
                    scene: paragraphs.length + 1,
                    text: `تأمل ما قرأت في قصة «${title}»، ثم أجب عن السؤال الختامي.`,
                    reflectionQuestion: value('content-question'),
                    options,
                    correctIndex: correct,
                    xpReward: 25
                }
            ];
        } else if (kind === 'film') {
            const scenes = value('content-scenes').split('\n').map(line => {
                const [sceneTitle, ...subtitles] = line.split('|');
                return { title: sceneTitle.trim(), subtitles: subtitles.join('|').trim() };
            }).filter(scene => scene.title && scene.subtitles);
            if (!scenes.length) throw new Error('أضف مشهداً واحداً على الأقل بصيغة: عنوان المشهد | نص المشهد.');
            const options = value('content-options').split('\n').map(option => option.trim()).filter(Boolean);
            const correct = Number(value('content-correct')) - 1;
            const quizQuestion = value('content-question');
            if (quizQuestion && (options.length < 2 || correct < 0 || correct >= options.length)) {
                throw new Error('أدخل خيارين على الأقل ورقم الإجابة الصحيحة لسؤال الفيلم.');
            }
            payload.category = category || 'أفلام المعلم';
            payload.duration = `${Math.max(1, scenes.length * 2)} دقائق`;
            payload.scenes = scenes;
            if (quizQuestion) payload.quiz = { question: quizQuestion, options, correct };
        } else if (kind === 'section') {
            if (!summary) throw new Error('أدخل وصف القسم.');
            const link = value('content-link');
            if (link) {
                let parsedLink;
                try {
                    parsedLink = new URL(link, window.location.href);
                } catch {
                    throw new Error('أدخل رابطاً صحيحاً يبدأ بـ https:// أو http://.');
                }
                if (!['http:', 'https:'].includes(parsedLink.protocol)) {
                    throw new Error('يسمح فقط بروابط صفحات الويب الآمنة.');
                }
                payload.link = parsedLink.href;
            }
        } else if (kind === 'appearance') {
            payload.siteName = title;
            payload.primaryColor = value('content-primary-color');
            payload.secondaryColor = value('content-secondary-color');
            payload.accentColor = value('content-accent-color');
        }

        if (!title) throw new Error('اكتب عنواناً للمحتوى.');
        return {
            id: value('content-id') || (kind === 'appearance' ? 'site-appearance' : undefined),
            kind,
            title,
            category,
            payload
        };
    }

    async saveForm(event) {
        event.preventDefault();
        const form = event.currentTarget;
        const button = form.querySelector('[type="submit"]');
        button.disabled = true;
        try {
            const entry = this.readForm(form);
            await this.save(entry.kind, entry);
            form.reset();
            form.elements.namedItem('content-id').value = '';
            this.updateFields();
            this.setStatus('تم حفظ المحتوى ومزامنته لجميع مستخدمي المنصة.');
        } catch (error) {
            console.error('تعذر حفظ محتوى المنصة.', error);
            this.setStatus(`تعذر الحفظ: ${error.message}`, true);
        } finally {
            button.disabled = false;
        }
    }

    setStatus(message, isError = false) {
        const status = document.getElementById('teacher-content-status');
        if (!status) return;
        status.textContent = message;
        status.classList.toggle('text-danger', isError);
        status.classList.toggle('text-success', !isError);
    }

    setupStudio() {
        const form = document.getElementById('teacher-content-form');
        if (!form || form.dataset.ready === 'true') return;
        form.dataset.ready = 'true';
        form.addEventListener('submit', event => this.saveForm(event));
        document.getElementById('teacher-content-kind')?.addEventListener('change', () => this.updateFields());
        document.getElementById('teacher-content-reset')?.addEventListener('click', () => {
            form.reset();
            form.elements.namedItem('content-id').value = '';
            this.updateFields();
        });
        this.updateFields();
        this.renderStudioList();
        this.applyAppearance();
        if (this.loadError) {
            this.setStatus('تعذّر تحميل المحتوى السحابي. نفّذ تحديث supabase-schema.sql في SQL Editor ثم أعد تحميل الصفحة.', true);
        }
    }
}

window.platformContent = new PlatformContent();
window.addEventListener('platform-content-ready', () => window.platformContent?.refreshPages());
