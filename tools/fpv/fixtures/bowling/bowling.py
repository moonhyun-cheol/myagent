import random
import time

TOTAL_FRAMES = 10
MAX_PINS = 10
PIN_ROWS = [[0, 1, 2, 3], [4, 5, 6], [7, 8], [9]]


def reset_pins():
    return [True] * MAX_PINS


def display_pins(standing):
    print("\n      7 8 9 10")
    print("       " + " ".join("●" if standing[i] else "○" for i in PIN_ROWS[0]))
    print("        " + " ".join("●" if standing[i] else "○" for i in PIN_ROWS[1]))
    print("         " + " ".join("●" if standing[i] else "○" for i in PIN_ROWS[2]))
    print("          " + " ".join("●" if standing[i] else "○" for i in PIN_ROWS[3]))
    print()


def remaining_pins(standing):
    return sum(1 for pin in standing if pin)


def roll_ball_auto(standing, max_pins):
    pins = random.randint(0, max_pins)
    indices = [i for i in range(MAX_PINS) if standing[i]]
    random.shuffle(indices)

    for i in indices[:pins]:
        standing[i] = False

    return pins


def roll_ball_manual(max_pins, prompt):
    while True:
        try:
            pins = int(input(prompt).strip())
            if 0 <= pins <= max_pins:
                return pins
            print(f"  0부터 {max_pins} 사이 숫자를 입력하세요.")
        except ValueError:
            print("  숫자를 입력하세요.")


def apply_manual_knockdown(standing, pins):
    indices = [i for i in range(MAX_PINS) if standing[i]]
    random.shuffle(indices)

    for i in indices[:pins]:
        standing[i] = False


def score_game(rolls):
    totals = []
    total = 0
    roll_idx = 0

    for frame in range(TOTAL_FRAMES):
        if roll_idx >= len(rolls):
            break

        if frame < 9:
            first = rolls[roll_idx]

            if first == 10:
                if roll_idx + 2 >= len(rolls):
                    break
                total += 10 + rolls[roll_idx + 1] + rolls[roll_idx + 2]
                totals.append(total)
                roll_idx += 1
            else:
                if roll_idx + 1 >= len(rolls):
                    break

                second = rolls[roll_idx + 1]
                frame_sum = first + second

                if frame_sum == 10:
                    if roll_idx + 2 >= len(rolls):
                        break
                    total += 10 + rolls[roll_idx + 2]
                else:
                    total += frame_sum

                totals.append(total)
                roll_idx += 2

        else:
            remaining = rolls[roll_idx:]

            if not remaining:
                break

            if remaining[0] == 10:
                if len(remaining) < 3:
                    break
                total += sum(remaining[:3])
            else:
                if len(remaining) < 2:
                    break
                if remaining[0] + remaining[1] == 10:
                    if len(remaining) < 3:
                        break
                    total += sum(remaining[:3])
                else:
                    total += sum(remaining[:2])

            totals.append(total)
            break

    return totals


def roll_symbols(rolls):
    symbols = []
    idx = 0

    for frame in range(TOTAL_FRAMES):
        if idx >= len(rolls):
            break

        if frame < 9:
            if rolls[idx] == 10:
                symbols.append("X")
                idx += 1
            else:
                first = rolls[idx]
                second = rolls[idx + 1] if idx + 1 < len(rolls) else None

                s1 = "-" if first == 0 else str(first)

                if second is None:
                    s2 = ""
                elif first + second == 10:
                    s2 = "/"
                elif second == 0:
                    s2 = "-"
                else:
                    s2 = str(second)

                symbols.append(f"{s1} {s2}".strip())
                idx += 2
        else:
            r = rolls[idx:idx + 3]
            parts = []

            for i, v in enumerate(r):
                if v == 10:
                    parts.append("X")
                elif i > 0 and r[i - 1] != 10 and r[i - 1] + v == 10:
                    parts.append("/")
                elif v == 0:
                    parts.append("-")
                else:
                    parts.append(str(v))

            symbols.append(" ".join(parts))
            break

    return symbols


def show_scoreboard(rolls, frame_scores, current_frame):
    syms = roll_symbols(rolls)

    print("\n" + "=" * 52)
    print(f"현재 프레임: {min(current_frame, 10)}")
    print("  +---+---+---+---+---+---+---+---+---+-----+")
    print("  | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10  |")
    print("  +---+---+---+---+---+---+---+---+---+-----+")

    line = "  |"
    for i in range(9):
        s = syms[i] if i < len(syms) else ""
        line += f"{s:^3}|"
    s10 = syms[9] if len(syms) > 9 else ""
    line += f"{s10:^5}|"
    print(line)

    print("  +---+---+---+---+---+---+---+---+---+-----+")

    line = "  |"
    for i in range(9):
        if i < len(frame_scores):
            line += f"{frame_scores[i]:^3}|"
        else:
            line += f"{'-':^3}|"
    if len(frame_scores) > 9:
        line += f"{frame_scores[9]:^5}|"
    else:
        line += f"{'-':^5}|"
    print(line)

    print("  +---+---+---+---+---+---+---+---+---+-----+")
    total = frame_scores[-1] if frame_scores else 0
    print(f"  TOTAL: {total}")
    print("=" * 52)


def choose_mode():
    while True:
        mode = input("모드를 선택하세요 - 자동(A) / 수동(M): ").strip().lower()
        if mode in ("a", "m"):
            return mode
        print("  A 또는 M을 입력하세요.")


def play_frame(frame_num, mode, rolls):
    standing = reset_pins()

    print(f"\n🎳 {frame_num}프레임")
    display_pins(standing)

    if frame_num < 10:
        first_remaining = remaining_pins(standing)

        if mode == "a":
            time.sleep(0.7)
            first = roll_ball_auto(standing, first_remaining)
        else:
            first = roll_ball_manual(first_remaining, f"  첫 번째 투구 (0~{first_remaining}): ")
            apply_manual_knockdown(standing, first)

        rolls.append(first)
        print(f"  첫 번째 투구: {first}핀")
        display_pins(standing)

        if first == 10:
            print("  스트라이크!")
            return

        second_remaining = remaining_pins(standing)

        if mode == "a":
            time.sleep(0.7)
            second = roll_ball_auto(standing, second_remaining)
        else:
            second = roll_ball_manual(second_remaining, f"  두 번째 투구 (0~{second_remaining}): ")
            apply_manual_knockdown(standing, second)

        rolls.append(second)
        print(f"  두 번째 투구: {second}핀")
        display_pins(standing)

        if first + second == 10:
            print("  스페어!")
        else:
            print(f"  프레임 점수: {first + second}")

    else:
        first_remaining = remaining_pins(standing)

        if mode == "a":
            time.sleep(0.7)
            first = roll_ball_auto(standing, first_remaining)
        else:
            first = roll_ball_manual(first_remaining, f"  첫 번째 투구 (0~{first_remaining}): ")
            apply_manual_knockdown(standing, first)

        rolls.append(first)
        print(f"  첫 번째 투구: {first}핀")
        display_pins(standing)

        if first == 10:
            print("  스트라이크!")
            standing = reset_pins()

            if mode == "a":
                time.sleep(0.7)
                second = roll_ball_auto(standing, MAX_PINS)
            else:
                second = roll_ball_manual(MAX_PINS, f"  두 번째 투구 (0~{MAX_PINS}): ")
                apply_manual_knockdown(standing, second)

            rolls.append(second)
            print(f"  두 번째 투구: {second}핀")
            display_pins(standing)

            if second == 10:
                standing = reset_pins()

            third_limit = remaining_pins(standing) if second != 10 else MAX_PINS

            if mode == "a":
                time.sleep(0.7)
                third = roll_ball_auto(standing, third_limit)
            else:
                third = roll_ball_manual(third_limit, f"  세 번째 투구 (0~{third_limit}): ")
                apply_manual_knockdown(standing, third)

            rolls.append(third)
            print(f"  세 번째 투구: {third}핀")
            display_pins(standing)

        else:
            second_remaining = remaining_pins(standing)

            if mode == "a":
                time.sleep(0.7)
                second = roll_ball_auto(standing, second_remaining)
            else:
                second = roll_ball_manual(second_remaining, f"  두 번째 투구 (0~{second_remaining}): ")
                apply_manual_knockdown(standing, second)

            rolls.append(second)
            print(f"  두 번째 투구: {second}핀")
            display_pins(standing)

            if first + second == 10:
                print("  스페어!")
                standing = reset_pins()

                if mode == "a":
                    time.sleep(0.7)
                    third = roll_ball_auto(standing, MAX_PINS)
                else:
                    third = roll_ball_manual(MAX_PINS, f"  보너스 투구 (0~{MAX_PINS}): ")
                    apply_manual_knockdown(standing, third)

                rolls.append(third)
                print(f"  보너스 투구: {third}핀")
                display_pins(standing)


def play_game():
    rolls = []
    mode = choose_mode()

    for frame in range(1, TOTAL_FRAMES + 1):
        play_frame(frame, mode, rolls)
        frame_scores = score_game(rolls)
        show_scoreboard(rolls, frame_scores, frame)

    final_scores = score_game(rolls)
    final_total = final_scores[-1] if final_scores else 0

    print("\n🏁 게임 종료!")
    print(f"최종 점수: {final_total}")

    if final_total == 300:
        print("퍼펙트 게임입니다! 🎉")


def main():
    print("볼링 게임에 오신 것을 환영합니다! 🎳")

    while True:
        play_game()
        again = input("\n다른 게임을 시작할까요? (y/n): ").strip().lower()
        if again != "y":
            break

    print("\nThanks for playing!\n")


if __name__ == "__main__":
    main()
