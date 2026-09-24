import { createEmptyCard, fsrs, generatorParameters, Rating, type Card } from "ts-fsrs";

export type ReviewRating = 1 | 2 | 3 | 4;

const toJson = (card: Card) => ({
  ...card,
  due: card.due.toISOString(),
  last_review: card.last_review ? card.last_review.toISOString() : null,
});
const fromJson = (value: Record<string, unknown>): Card => ({
  ...(value as unknown as Card),
  due: new Date(String(value.due)),
  last_review: value.last_review ? new Date(String(value.last_review)) : undefined,
});

export function newReviewCard(now = new Date()) {
  const card = createEmptyCard(now);
  return { card: toJson(card), dueAt: card.due.toISOString() };
}

export function scheduleReview(
  cardJson: Record<string, unknown>,
  rating: ReviewRating,
  desiredRetention: number,
  now = new Date(),
) {
  const scheduler = fsrs(
    generatorParameters({ request_retention: desiredRetention, enable_fuzz: true }),
  );
  const grade = [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy][rating - 1]!;
  const result = scheduler.next(fromJson(cardJson), now, grade as 1 | 2 | 3 | 4);
  return { card: toJson(result.card), dueAt: result.card.due.toISOString() };
}
