package models

import "time"

// Profile maps to the "profiles" table.
type Profile struct {
	ID        int32     `gorm:"primaryKey;autoIncrement:false"`
	Bio       *string   `gorm:"type:text"`
	Avatar    *string   `gorm:"size:100"`
	UserID    int32     `gorm:"not null"`
	CreatedAt time.Time `gorm:"not null;autoCreateTime"`
	UpdatedAt time.Time `gorm:"not null;autoUpdateTime"`
}
