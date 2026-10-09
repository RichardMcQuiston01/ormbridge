<?php

declare(strict_types=1);

namespace App\Entity;

use App\Enum\Status;
use DateTimeImmutable;
use Doctrine\DBAL\Types\Types;
use Doctrine\ORM\Mapping as ORM;
use Symfony\Component\Uid\Uuid;

/**
 * Behaviour that lives outside the mapping attributes: lifecycle callbacks,
 * constructor assignments and property initialisers.
 */
#[ORM\Entity]
#[ORM\Table(name: 'article')]
#[ORM\HasLifecycleCallbacks]
class Article
{
    #[ORM\Id]
    #[ORM\GeneratedValue]
    #[ORM\Column(type: Types::INTEGER)]
    private ?int $id = null;

    #[ORM\Column(name: 'public_id', type: Types::GUID, unique: true)]
    private string $publicId;

    #[ORM\Column(type: Types::STRING, length: 20, enumType: Status::class)]
    private Status $status;

    #[ORM\Column(type: Types::JSON)]
    private array $metadata = [];

    #[ORM\Column(type: Types::INTEGER)]
    private int $views = 0;

    #[ORM\Column(type: Types::BOOLEAN)]
    private bool $published = false;

    #[ORM\Column(type: Types::STRING, length: 40)]
    private string $label = 'untitled';

    #[ORM\Column(name: 'imported_at', type: Types::DATETIME_IMMUTABLE)]
    private DateTimeImmutable $importedAt;

    #[ORM\Column(name: 'created_at', type: Types::DATETIME_IMMUTABLE)]
    private DateTimeImmutable $createdAt;

    #[ORM\Column(name: 'updated_at', type: Types::DATETIME_IMMUTABLE)]
    private DateTimeImmutable $updatedAt;

    #[ORM\Column(name: 'slug', type: Types::STRING, length: 80)]
    private string $slug;

    public function __construct()
    {
        $this->publicId = self::generateUuid();
        $this->status = Status::Draft;
        $this->importedAt = new \DateTimeImmutable();
        $this->slug = $this->buildSlug();
    }

    #[ORM\PrePersist]
    public function stampCreated(): void
    {
        $this->createdAt = new \DateTimeImmutable();
    }

    #[ORM\PreUpdate]
    public function touch(): void
    {
        $this->updatedAt = new \DateTimeImmutable();
        $this->views = $this->views + 1;
    }

    private function buildSlug(): string
    {
        return 'article';
    }

    private static function generateUuid(): string
    {
        return Uuid::v4()->toRfc4122();
    }
}
