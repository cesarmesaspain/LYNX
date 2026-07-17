#define FEATURE_X 1
#define VERSION 2
#if defined(FEATURE_X) && (VERSION * 2 == 4) && VERSION >= 2 && !defined(DISABLED)
int add(int a, int b);
#else
int forbidden_branch(void);
#endif
#undef FEATURE_X
#if FEATURE_X || VERSION < 2
int forbidden_after_undef(void);
#endif
