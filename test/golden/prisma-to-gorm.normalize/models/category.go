package models

import "time"

// Category maps to the "categories" table.
type Category struct {
	ID        int32     `gorm:"primaryKey;autoIncrement"`
	CreatedAt time.Time `gorm:"not null;autoCreateTime"`
	UpdatedAt time.Time `gorm:"not null;autoUpdateTime"`
	Name      string    `gorm:"size:100;not null;unique"`
	Slug      string    `gorm:"size:50;not null"`
	ParentID  *int32

	Parent   *Category  `gorm:"foreignKey:ParentID;constraint:OnDelete:SET NULL"`
	Children []Category `gorm:"foreignKey:ParentID;constraint:OnDelete:SET NULL"`
	PostSet  []Post     `gorm:"foreignKey:CategoryID;constraint:OnDelete:RESTRICT"`
}
