package main

import "fmt"

var cheers = []string{
	"Nailed it!",
	"Absolutely legendary.",
	"The crowd goes wild!",
	"Another one!",
	"Pure joy, served fresh.",
	"Confetti levels: critical.",
	"You're on a roll!",
	"Party mode engaged.",
}

// PartyService is exposed to the frontend; Wails generates typed bindings for its methods.
type PartyService struct{}

// Celebrate returns a cheer for the given pop count.
func (p *PartyService) Celebrate(count int) string {
	switch {
	case count == 1:
		return "First pop! Welcome to the party."
	case count%25 == 0:
		return fmt.Sprintf("%d pops! Milestone unlocked.", count)
	default:
		return cheers[count%len(cheers)]
	}
}
