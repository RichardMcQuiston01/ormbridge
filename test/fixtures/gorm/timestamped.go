package models

import "time"

// TimeStamped is embedded by the models that keep creation and update times.
// GORM fills CreatedAt and UpdatedAt by convention, so no tags are needed.
type TimeStamped struct {
	CreatedAt time.Time
	UpdatedAt time.Time
}
