#pragma once

#define MATH_LIMIT 64
#define MATH_DOUBLE(value) ((value) * 2)
#define MATH_ADD(left, right) add_numbers((left), (right))

int add_numbers(int left, int right);

typedef struct Counter {
  int value;
  int history[4];
} Counter;

enum State { STATE_IDLE, STATE_BUSY = 2 };
union Payload { int integer; float decimal; };

extern int public_value, second_value;
extern int *current_value;
extern int (*transform_value)(int);
