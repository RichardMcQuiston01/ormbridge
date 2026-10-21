package models

import "time"

// User maps to the "users" table.
type User struct {
	ID        int32     `gorm:"primaryKey;autoIncrement:false"`
	CreatedAt time.Time `gorm:"not null;autoCreateTime"`
	UpdatedAt time.Time `gorm:"not null;autoUpdateTime"`
}
