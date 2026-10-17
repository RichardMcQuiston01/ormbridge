package models

import "time"

// Category maps to the "blog_category" table.
type Category struct {
	CreatedAt time.Time `gorm:"not null;autoCreateTime"`
	UpdatedAt time.Time `gorm:"not null;autoUpdateTime"`
	ID        int32     `gorm:"primaryKey;autoIncrement"`
	Name      string    `gorm:"size:100;not null;unique"`
	Slug      string    `gorm:"size:50;not null"`
	ParentID  *int32

	Parent   *Category  `gorm:"foreignKey:ParentID;constraint:OnDelete:SET NULL"`
	Children []Category `gorm:"foreignKey:ParentID;constraint:OnDelete:SET NULL"`
	Posts    []Post     `gorm:"foreignKey:CategoryID;constraint:OnDelete:RESTRICT"`
}

// TableName overrides GORM's default table name (categories).
func (Category) TableName() string {
	return "blog_category"
}
