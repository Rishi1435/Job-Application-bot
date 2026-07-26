/**
 * A small motion toolkit, in the spirit of Framer Motion.
 *
 * Framer Motion is a React library and this dashboard is deliberately
 * build-step-free vanilla JS, so its primitives are reimplemented here on top of
 * the Web Animations API - the same engine Framer itself drives:
 *
 *   spring()    physically-derived easing curves, instead of ease-in-out
 *   enter()     an `initial` -> `animate` transition for one element
 *   stagger()   the same, across a list, offset in time
 *   flip()      `layout` animations: measure, mutate the DOM, animate the delta
 *   presence()  `AnimatePresence` - play an exit animation, *then* remove
 *   countUp()   animated numerals for the stat cards
 *   pressable() the `whileTap` scale-down that makes a button feel physical
 *
 * Everything degrades to an instant, non-animated result when the user has asked
 * for reduced motion - each helper still performs its DOM work and resolves, so
 * callers never need to branch on it.
 */

(() => {
    'use strict';

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

    /** @returns {boolean} whether animation should be skipped entirely. */
    const prefersReduced = () => reduced.matches;

    /**
     * Easing curves. The spring entries are cubic-bezier approximations of
     * Framer's default spring physics - overshooting slightly on the way in,
     * which is what stops an interface from feeling like it is fading rather
     * than moving.
     */
    const EASING = {
        spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
        springSoft: 'cubic-bezier(0.22, 1, 0.36, 1)',
        springStiff: 'cubic-bezier(0.16, 1.2, 0.3, 1)',
        out: 'cubic-bezier(0.16, 1, 0.3, 1)',
        inOut: 'cubic-bezier(0.65, 0, 0.35, 1)',
        in: 'cubic-bezier(0.55, 0, 1, 0.45)',
    };

    const DURATION = { fast: 180, base: 320, slow: 520 };

    /**
     * Runs a WAAPI animation and resolves when it finishes.
     *
     * @param {Element} element
     * @param {Keyframe[]|PropertyIndexedKeyframes} keyframes
     * @param {KeyframeAnimationOptions} [options]
     * @returns {Promise<void>}
     */
    function animate(element, keyframes, options = {}) {
        if (!element || prefersReduced()) return Promise.resolve();

        const animation = element.animate(keyframes, {
            duration: DURATION.base,
            easing: EASING.springSoft,
            fill: 'both',
            ...options,
        });

        return animation.finished
            .then(() => {
                // Commit nothing: `fill: both` would otherwise pin inline styles
                // and stop later CSS (hover, theme changes) from taking effect.
                animation.cancel();
            })
            .catch(() => {});
    }

    /* -------------------------------------------------------------- */
    /* Entrances                                                       */
    /* -------------------------------------------------------------- */

    /** Named entrance transitions, mirroring Framer's `initial`/`animate` pairs. */
    const VARIANTS = {
        fadeUp: { from: { opacity: 0, transform: 'translateY(14px)' }, to: { opacity: 1, transform: 'translateY(0)' } },
        fadeDown: { from: { opacity: 0, transform: 'translateY(-10px)' }, to: { opacity: 1, transform: 'translateY(0)' } },
        fade: { from: { opacity: 0 }, to: { opacity: 1 } },
        scaleIn: { from: { opacity: 0, transform: 'scale(0.94)' }, to: { opacity: 1, transform: 'scale(1)' } },
        slideRight: { from: { opacity: 0, transform: 'translateX(-16px)' }, to: { opacity: 1, transform: 'translateX(0)' } },
        pop: { from: { opacity: 0, transform: 'scale(0.8)' }, to: { opacity: 1, transform: 'scale(1)' } },
    };

    /**
     * Plays one element's entrance.
     *
     * @param {Element} element
     * @param {keyof VARIANTS|{from:object,to:object}} [variant]
     * @param {KeyframeAnimationOptions} [options]
     * @returns {Promise<void>}
     */
    function enter(element, variant = 'fadeUp', options = {}) {
        const preset = typeof variant === 'string' ? VARIANTS[variant] || VARIANTS.fadeUp : variant;
        return animate(element, [preset.from, preset.to], { easing: EASING.springSoft, ...options });
    }

    /**
     * Plays the same entrance across a list, offset in time.
     *
     * The offset is capped so a hundred-row board does not take four seconds to
     * finish arriving - past ~14 items the remaining rows share the last slot.
     *
     * @param {Iterable<Element>} elements
     * @param {keyof VARIANTS|{from:object,to:object}} [variant]
     * @param {{step?:number, start?:number, max?:number, duration?:number}} [options]
     * @returns {Promise<void[]>}
     */
    function stagger(elements, variant = 'fadeUp', options = {}) {
        const { step = 28, start = 0, max = 14, duration = DURATION.base } = options;
        const list = Array.from(elements);

        return Promise.all(
            list.map((element, index) =>
                enter(element, variant, { delay: start + Math.min(index, max) * step, duration })
            )
        );
    }

    /* -------------------------------------------------------------- */
    /* Layout (FLIP)                                                   */
    /* -------------------------------------------------------------- */

    /**
     * Framer's `layout` prop, by hand: First, Last, Invert, Play.
     *
     * Measures the tracked children, lets `mutate` reorder or refilter them, then
     * animates each survivor from where it *was* to where it now is. Sorting the
     * board therefore reads as the rows moving, rather than the list blinking
     * into a new order.
     *
     * @param {Element} container
     * @param {() => void} mutate DOM mutation to run between the measurements
     * @param {{selector?:string, duration?:number}} [options]
     * @returns {void}
     */
    function flip(container, mutate, options = {}) {
        const { selector = ':scope > *', duration = DURATION.base } = options;

        if (!container || prefersReduced()) {
            mutate();
            return;
        }

        const before = new Map();
        for (const child of container.querySelectorAll(selector)) {
            const key = child.dataset.flipKey;
            if (key) before.set(key, child.getBoundingClientRect());
        }

        mutate();

        for (const child of container.querySelectorAll(selector)) {
            const key = child.dataset.flipKey;
            const previous = key && before.get(key);
            if (!previous) continue;

            const next = child.getBoundingClientRect();
            const dx = previous.left - next.left;
            const dy = previous.top - next.top;
            if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;

            animate(child, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], {
                duration,
                easing: EASING.out,
            });
        }
    }

    /**
     * Framer's shared `layoutId`: slides a single indicator to sit behind the
     * newly active element instead of cross-fading two separate underlines.
     *
     * @param {HTMLElement} indicator absolutely positioned inside `target`'s offset parent
     * @param {HTMLElement} target element the indicator should cover
     * @returns {void}
     */
    function moveIndicator(indicator, target) {
        if (!indicator || !target) return;

        const parent = indicator.offsetParent || indicator.parentElement;
        if (!parent) return;

        const parentBox = parent.getBoundingClientRect();
        const box = target.getBoundingClientRect();
        const left = box.left - parentBox.left;

        if (prefersReduced() || !indicator.dataset.placed) {
            indicator.style.transition = 'none';
            indicator.style.width = `${box.width}px`;
            indicator.style.transform = `translateX(${left}px)`;
            indicator.dataset.placed = 'true';
            // Force a reflow so the transition-less placement is not batched with
            // the transition being restored below.
            void indicator.offsetWidth;
            indicator.style.transition = '';
            return;
        }

        indicator.style.width = `${box.width}px`;
        indicator.style.transform = `translateX(${left}px)`;
    }

    /* -------------------------------------------------------------- */
    /* Presence                                                        */
    /* -------------------------------------------------------------- */

    /**
     * Framer's `AnimatePresence`: plays an exit animation and only then removes
     * the element, so a deleted row leaves rather than vanishing.
     *
     * @param {Element} element
     * @param {keyof VARIANTS|{from:object,to:object}} [variant]
     * @returns {Promise<void>}
     */
    async function exit(element, variant = 'fade') {
        if (!element) return;

        const preset = typeof variant === 'string' ? VARIANTS[variant] || VARIANTS.fade : variant;
        // An exit is the entrance played backwards.
        await animate(element, [preset.to, preset.from], { duration: DURATION.fast, easing: EASING.in });
        element.remove();
    }

    /* -------------------------------------------------------------- */
    /* Micro-interactions                                              */
    /* -------------------------------------------------------------- */

    /**
     * Animates a number from its current value to a new one.
     *
     * @param {HTMLElement} element
     * @param {number} to
     * @param {{duration?:number, decimals?:number}} [options]
     * @returns {void}
     */
    function countUp(element, to, options = {}) {
        if (!element) return;

        const { duration = 700, decimals = 0 } = options;
        const target = Number(to);

        if (!Number.isFinite(target)) {
            element.textContent = to === null || to === undefined ? '-' : String(to);
            return;
        }

        const from = Number(String(element.textContent).replace(/[^\d.-]/g, '')) || 0;
        if (prefersReduced() || from === target) {
            element.textContent = target.toFixed(decimals);
            return;
        }

        const started = performance.now();
        // easeOutExpo: fast off the mark, settling gently on the final value.
        const ease = (t) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t));

        const step = (now) => {
            const progress = Math.min(1, (now - started) / duration);
            const value = from + (target - from) * ease(progress);
            element.textContent = value.toFixed(decimals);
            if (progress < 1) requestAnimationFrame(step);
        };

        requestAnimationFrame(step);
    }

    /**
     * Framer's `whileTap`: a brief scale-down on pointer press.
     *
     * Delegated from the document so it applies to elements rendered later,
     * which is most of this dashboard.
     *
     * @param {string} [selector]
     * @returns {void}
     */
    function pressable(selector = '[data-press]') {
        document.addEventListener(
            'pointerdown',
            (event) => {
                const target = event.target.closest(selector);
                if (!target || prefersReduced()) return;
                target.style.transform = 'scale(0.96)';
            },
            { passive: true }
        );

        const release = (event) => {
            const target = event.target?.closest?.(selector);
            if (target) target.style.transform = '';
        };

        document.addEventListener('pointerup', release, { passive: true });
        document.addEventListener('pointercancel', release, { passive: true });
        document.addEventListener('pointerleave', release, { passive: true });
    }

    /**
     * Reveals elements as they scroll into view, once each.
     *
     * @param {string} [selector]
     * @returns {void}
     */
    function revealOnScroll(selector = '[data-reveal]') {
        if (prefersReduced() || !('IntersectionObserver' in window)) {
            document.querySelectorAll(selector).forEach((element) => element.classList.add('is-revealed'));
            return;
        }

        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (!entry.isIntersecting) continue;
                    entry.target.classList.add('is-revealed');
                    observer.unobserve(entry.target);
                }
            },
            { rootMargin: '0px 0px -40px 0px', threshold: 0.05 }
        );

        document.querySelectorAll(selector).forEach((element) => observer.observe(element));
    }

    /**
     * Draws an SVG ring from 0 to `percent` by animating its dash offset.
     *
     * @param {SVGCircleElement} circle
     * @param {number} percent 0-100
     * @param {number} [radius]
     * @returns {void}
     */
    function drawRing(circle, percent, radius = 18) {
        if (!circle) return;

        const circumference = 2 * Math.PI * radius;
        const offset = circumference * (1 - Math.max(0, Math.min(100, percent)) / 100);

        circle.style.strokeDasharray = String(circumference);

        if (prefersReduced()) {
            circle.style.strokeDashoffset = String(offset);
            return;
        }

        circle.style.strokeDashoffset = String(circumference);
        animate(circle, [{ strokeDashoffset: circumference }, { strokeDashoffset: offset }], {
            duration: 900,
            easing: EASING.out,
        }).then(() => {
            circle.style.strokeDashoffset = String(offset);
        });
    }

    /**
     * Cross-fades between two top-level views (auth <-> dashboard).
     *
     * @param {HTMLElement} outgoing
     * @param {HTMLElement} incoming
     * @returns {Promise<void>}
     */
    async function transitionView(outgoing, incoming) {
        if (outgoing && !outgoing.hidden) {
            await animate(outgoing, [{ opacity: 1 }, { opacity: 0, transform: 'scale(0.98)' }], {
                duration: DURATION.fast,
                easing: EASING.in,
            });
            outgoing.hidden = true;
        }

        if (incoming) {
            incoming.hidden = false;
            await enter(incoming, 'fade', { duration: DURATION.base });
        }
    }

    window.Motion = {
        EASING,
        DURATION,
        VARIANTS,
        prefersReduced,
        animate,
        enter,
        stagger,
        exit,
        flip,
        moveIndicator,
        countUp,
        pressable,
        revealOnScroll,
        drawRing,
        transitionView,
    };
})();
