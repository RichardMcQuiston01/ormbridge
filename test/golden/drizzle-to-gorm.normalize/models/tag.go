package models

import "time"

// Tag maps to the "tags" table.
type Tag struct {
	ID        int32     `gorm:"primaryKey;autoIncrement"`
	Label     string    `gorm:"size:50;not null"`
	CreatedAt time.Time `gorm:"not null;autoCreateTime"`
	UpdatedAt time.Time `gorm:"not null;autoUpdateTime"`

	Posts []PostTag `gorm:"foreignKey:TagID;constraint:OnDelete:CASCADE"`
}
