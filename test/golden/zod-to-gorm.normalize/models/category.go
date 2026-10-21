package models

import "time"

// Category maps to the "categories" table.
type Category struct {
	ID        int32     `gorm:"primaryKey;autoIncrement:false"`
	CreatedAt time.Time `gorm:"not null;autoCreateTime"`
	UpdatedAt time.Time `gorm:"not null"`
	Name      string    `gorm:"size:100;not null"`
	Slug      string    `gorm:"size:50;not null"`
	ParentID  *int32
}
